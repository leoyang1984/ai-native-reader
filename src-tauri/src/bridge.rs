//! Private Unix-domain channel. It is not a network MCP endpoint.
use crate::{context::{Availability, ContextHub, ContextSnapshot, ContextStatus, TextState}, query::{self, Arguments}, service::{context_locked, locked, Database, Result, RuntimeContext}, store::Store};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs, io::{BufRead, BufReader, Read, Write}, path::{Path, PathBuf}, sync::{atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering}, mpsc::{sync_channel, SyncSender}, Arc, Mutex}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::{Emitter, Manager};
#[cfg(unix)]
use std::os::unix::{fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt}, net::{UnixListener, UnixStream}};

const MAX_REQUEST: u64 = 65_536;
pub const MAX_RESPONSE: u64 = 4_194_304;
const WAIT: Duration = Duration::from_secs(10);
type Pending = HashMap<String, SyncSender<Result<Value>>>;
pub struct FrontendRequests { pending: Mutex<Pending>, sequence: AtomicU64 }
impl FrontendRequests {
    pub fn new() -> Self { Self { pending:Mutex::new(HashMap::new()), sequence:AtomicU64::new(0) } }
    pub fn complete(&self, id: String, result: Option<Value>, error: Option<String>) -> Result<()> {
        let sender = self.pending.lock().map_err(|_|"Reader 请求暂不可用。")?.remove(&id);
        if let Some(sender) = sender {
            let value = match (result,error) { (Some(value),None) => Ok(value), (None,Some(message)) => Err(message), _ => Err("Reader 响应格式无效。".into()) };
            let _ = sender.send(value);
        }
        Ok(()) // A response after expiry is intentionally ignored.
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FrontendRequest { id: String, action: String, arguments: Value, deadline: u64 }
fn frontend(app: &tauri::AppHandle, action: &str, arguments: Value) -> Result<Value> {
    let state = app.state::<FrontendRequests>();
    let id = format!("{}-{}", std::process::id(), state.sequence.fetch_add(1,Ordering::Relaxed));
    let (tx,rx) = sync_channel(1);
    state.pending.lock().map_err(|_|"Reader 请求暂不可用。")?.insert(id.clone(),tx);
    let deadline = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 + 8_000;
    let request = FrontendRequest { id:id.clone(), action:action.into(), arguments, deadline };
    let result = app.emit("reader-mcp-request",request).map_err(|_|"无法联系阅读界面。".to_string())
        .and_then(|_| rx.recv_timeout(Duration::from_secs(8)).map_err(|_|"Reader 界面响应超时；导航若已经开始，仍可能完成。".to_string())?);
    state.pending.lock().map_err(|_|"Reader 请求暂不可用。")?.remove(&id);
    result
}
fn capture(app: &tauri::AppHandle) -> Result<ContextSnapshot> {
    let initial = context_locked(&app.state::<RuntimeContext>())?.snapshot();
    if initial.availability == Availability::Initializing { return Ok(initial); }
    let result = frontend(app,"capture_context",json!({}))?;
    let mut snapshot: ContextSnapshot = serde_json::from_value(result).map_err(|_|"阅读上下文响应无效。")?;
    let state = app.state::<RuntimeContext>(); let hub = context_locked(&state)?;
    if !hub.contains_snapshot(&snapshot) { return Err("阅读上下文尚未同步，请重试。".into()); }
    let db = app.state::<Database>(); let store = locked(&db)?;
    snapshot.current.as_ref().ok_or("阅读上下文不可用。")?.validate(&store)?;
    if snapshot.last_known_reading.is_none() { snapshot.last_known_reading = initial.last_known_reading; }
    Ok(snapshot)
}
fn location_book(store: &Store, args: &Arguments) -> Result<()> {
    let book = store.query_book(args.book_id.as_deref().ok_or("缺少书籍 ID。")?)?.ok_or("这本 EPUB 尚未导入 Reader。")?;
    if args.fingerprint.as_ref() != Some(&book.fingerprint) { return Err("书籍文件指纹不匹配。".into()); }
    Ok(())
}
fn execute(app: &tauri::AppHandle, name: &str, value: &Value) -> Result<Value> {
    let args = query::arguments(name,value)?;
    if matches!(name,"get_highlights"|"get_notes"|"search_notes"|"get_reading_history") {
        let mut result = locked(&app.state::<Database>())?.query_page(name,&args)?;
        result["readerAvailability"] = json!("running"); return Ok(result);
    }
    if name == "open_location" {
        location_book(&*locked(&app.state::<Database>())?,&args)?;
        if context_locked(&app.state::<RuntimeContext>())?.snapshot().availability == Availability::Initializing { return Err("Reader 正在启动，请稍后再定位。".into()); }
        let result = frontend(app,"open_location",value.clone())?;
        if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); }
        return Ok(result);
    }
    let snapshot = capture(app)?;
    if name == "get_surrounding_text" && args.cfi.is_some() {
        location_book(&*locked(&app.state::<Database>())?,&args)?;
        let context = snapshot.current.as_ref().ok_or("Reader 当前没有可用阅读位置。")?;
        if context.status != ContextStatus::Reading || context.book.as_ref().map(|b|&b.id) != args.book_id.as_ref()
            || context.location.as_ref().map(|l|&l.href) != args.href.as_ref() { return Err("指定位置不在当前显示的章节；请明确调用 open_location 后再查询。".into()); }
        let result = frontend(app,"surrounding_text",json!({"location":value,"instanceId":context.instance_id,"revision":context.revision}))?;
        let surrounding = serde_json::from_value(result).map_err(|_|"附近正文响应无效。")?;
        // Verify all returned passages against the requested source before exposing them.
        let mut requested = context.clone();
        requested.location.as_mut().ok_or("缺少阅读位置。")?.cfi = args.cfi.clone().unwrap();
        requested.selection = None; requested.surrounding = Some(surrounding);
        requested.text_state = if requested.surrounding.as_ref().is_some_and(|t|t.unavailable_reason.is_some()) { TextState::Unavailable } else { TextState::Ready };
        requested.validate(&*locked(&app.state::<Database>())?)?;
        return Ok(json!({"source":"runtime","contextVersion":{"schemaVersion":context.schema_version,"instanceId":context.instance_id,"revision":context.revision,"capturedAt":context.captured_at},
            "book":context.book,"location":value,"textState":requested.text_state,"surrounding":requested.surrounding}));
    }
    query::current_result(name,snapshot)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request { version: u32, tool: String, arguments: Value }
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Response { version: u32, result: Option<Value>, error: Option<String> }
pub fn read_line(reader: &mut impl BufRead, max: u64) -> std::io::Result<Vec<u8>> {
    let mut line = Vec::new();
    reader.take(max+1).read_until(b'\n',&mut line)?;
    if line.len() as u64 > max { return Err(std::io::Error::new(std::io::ErrorKind::InvalidData,"message too large")); }
    Ok(line)
}
pub fn data_root() -> Result<PathBuf> {
    if cfg!(debug_assertions) { if let Some(value) = std::env::var_os("AINATIVE_READER_DATA_DIR") { return Ok(PathBuf::from(value)); } }
    let home = std::env::var_os("HOME").ok_or("无法定位 Reader 本地数据目录。")?;
    Ok(PathBuf::from(home).join("Library/Application Support/com.leoyang.ainativereader"))
}
#[cfg(unix)]
fn socket_path(root: &Path) -> PathBuf {
    let root = root.canonicalize().unwrap_or_else(|_|root.to_path_buf());
    let digest = Sha256::digest(root.as_os_str().as_encoded_bytes());
    let key: String = digest[..12].iter().map(|v|format!("{v:02x}")).collect();
    // Fixed short path, independent of the GUI/CLI's TMPDIR. Private directory permissions restrict access.
    PathBuf::from("/private/tmp").join(format!("ainr-{key}")).join("reader.sock")
}
#[cfg(unix)]
fn trusted_directory(path: &Path, create: bool) -> Result<bool> {
    let Some(parent) = path.parent() else { return Err("Reader 通道路径无效。".into()); };
    if create && !parent.exists() { fs::DirBuilder::new().mode(0o700).create(parent).map_err(|_|"无法创建 Reader 本机通道目录。")?; }
    let metadata = match fs::symlink_metadata(parent) {
        Ok(value) => value, Err(error) if error.kind()==std::io::ErrorKind::NotFound => return Ok(false), Err(_) => return Err("无法检查 Reader 本机通道。".into()),
    };
    let home_uid = fs::metadata(std::env::var_os("HOME").ok_or("用户目录不可用。")?).map_err(|_|"用户目录不可用。")?.uid();
    if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata.uid()!=home_uid || metadata.mode() & 0o077 != 0 { return Err("Reader 本机通道的所有者或访问权限无效。".into()); }
    Ok(true)
}
pub struct BridgeHost { stop: Arc<AtomicBool>, #[cfg(unix)] path: PathBuf, #[cfg(unix)] inode: u64 }
impl BridgeHost {
    pub fn stop(&self) {
        self.stop.store(true,Ordering::Release);
        #[cfg(unix)]
        if fs::symlink_metadata(&self.path).is_ok_and(|value|value.ino()==self.inode && value.file_type().is_socket()) { let _ = fs::remove_file(&self.path); }
    }
}
impl Drop for BridgeHost { fn drop(&mut self) { self.stop(); } }
#[cfg(unix)]
pub fn start(app: tauri::AppHandle, root: &Path) -> Result<BridgeHost> {
    let path = socket_path(root); trusted_directory(&path,true)?;
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if !metadata.file_type().is_socket() { return Err("Reader 本机通道已被其它文件占用。".into()); }
        match UnixStream::connect(&path) {
            Ok(_) => return Err("Reader 本机通道已经运行。".into()),
            Err(e) if matches!(e.kind(),std::io::ErrorKind::ConnectionRefused|std::io::ErrorKind::NotFound) => fs::remove_file(&path).map_err(|_|"无法清理旧 Reader 通道。")?,
            Err(_) => return Err("无法检查已有 Reader 通道。".into()),
        }
    }
    let listener = UnixListener::bind(&path).map_err(|_|"无法启动 Reader 本机通道。")?;
    fs::set_permissions(&path,fs::Permissions::from_mode(0o600)).map_err(|_|"无法限制 Reader 通道权限。")?;
    listener.set_nonblocking(true).map_err(|e|e.to_string())?;
    let inode = fs::symlink_metadata(&path).map_err(|e|e.to_string())?.ino();
    let stop = Arc::new(AtomicBool::new(false)); let shutdown = stop.clone(); let active = Arc::new(AtomicUsize::new(0));
    std::thread::spawn(move || {
        while !shutdown.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((stream,_)) => {
                    if active.fetch_add(1,Ordering::AcqRel)>=8 { active.fetch_sub(1,Ordering::AcqRel); continue; }
                    let app = app.clone(); let active = active.clone();
                    std::thread::spawn(move || { let _ = serve(stream,&app); active.fetch_sub(1,Ordering::AcqRel); });
                }
                Err(e) if e.kind()==std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => break,
            }
        }
    });
    Ok(BridgeHost {stop,path,inode})
}
#[cfg(unix)]
fn prepare_stream(stream: &UnixStream) -> Result<()> {
    // macOS accepted sockets inherit the listener's O_NONBLOCK flag. A partial
    // write would otherwise close the connection at the socket buffer boundary.
    stream.set_nonblocking(false).map_err(|e|e.to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).map_err(|e|e.to_string())?;
    stream.set_write_timeout(Some(WAIT)).map_err(|e|e.to_string())?;
    Ok(())
}
#[cfg(unix)]
fn serve(mut stream: UnixStream, app: &tauri::AppHandle) -> Result<()> {
    prepare_stream(&stream)?;
    let bytes = read_line(&mut BufReader::new(stream.try_clone().map_err(|e|e.to_string())?),MAX_REQUEST).map_err(|e|e.to_string())?;
    let result = serde_json::from_slice::<Request>(&bytes).map_err(|_|"Reader 请求格式无效。".into()).and_then(|request|
        if request.version!=1 { Err("Reader 通道版本不兼容。".into()) } else { execute(app,&request.tool,&request.arguments) });
    let response = match result { Ok(value) => Response{version:1,result:Some(value),error:None}, Err(message) => Response{version:1,result:None,error:Some(message)} };
    let mut bytes = serde_json::to_vec(&response).map_err(|e|e.to_string())?;
    if bytes.len() as u64 > MAX_RESPONSE {
        bytes = serde_json::to_vec(&Response {version:1,result:None,error:Some("Reader 响应超出长度范围，请缩小分页。".into())}).map_err(|e|e.to_string())?;
    }
    bytes.push(b'\n'); stream.write_all(&bytes).map_err(|e|e.to_string())
}
#[cfg(unix)]
pub fn call(root: &Path, name: &str, value: &Value) -> Result<Value> {
    let args = query::arguments(name,value)?; let path = socket_path(root);
    if !trusted_directory(&path,false)? { return offline(root,name,&args); }
    match UnixStream::connect(&path) {
        Ok(mut stream) => {
            stream.set_read_timeout(Some(Duration::from_secs(20))).map_err(|e|e.to_string())?;
            stream.set_write_timeout(Some(WAIT)).map_err(|e|e.to_string())?;
            let mut bytes = serde_json::to_vec(&json!({"version":1,"tool":name,"arguments":value})).map_err(|e|e.to_string())?;
            if bytes.len() as u64 > MAX_REQUEST { return Err("Reader 请求过长。".into()); }
            bytes.push(b'\n'); stream.write_all(&bytes).map_err(|e|e.to_string())?;
            let bytes = read_line(&mut BufReader::new(stream),MAX_RESPONSE).map_err(|_|"Reader 本机通信失败或超时；没有将旧记录冒充实时状态。")?;
            let response: Response = serde_json::from_slice(&bytes).map_err(|_|"Reader 通道响应无效。")?;
            match (response.version,response.result,response.error) { (1,Some(value),None) => Ok(value), (1,None,Some(error)) => Err(error), _ => Err("Reader 通道响应无效。".into()) }
        }
        Err(error) if matches!(error.kind(),std::io::ErrorKind::NotFound|std::io::ErrorKind::ConnectionRefused) => offline(root,name,&args),
        Err(_) => Err("无法访问 Reader 本机通道；运行状态未知。".into()),
    }
}
fn offline(root: &Path, name: &str, args: &Arguments) -> Result<Value> {
    if name=="open_location" || name=="get_surrounding_text" && args.cfi.is_some() { return Err("Reader 未运行，请先打开应用。".into()); }
    let store = Store::open_readonly(root)?;
    if matches!(name,"get_highlights"|"get_notes"|"search_notes"|"get_reading_history") {
        return match store { Some(store) => {
            let mut result = store.query_page(name,args)?; result["readerAvailability"] = json!("not_running"); Ok(result)
        }, None => {
            let mut result = query::empty_page(name,args)?; result["readerAvailability"] = json!("not_running"); Ok(result)
        } };
    }
    let last = store.as_ref().map(Store::last_reading_context).transpose()?.flatten();
    let mut hub = ContextHub::new(last); hub.stop(); query::current_result(name,hub.snapshot())
}
#[cfg(not(unix))]
pub fn start(_app: tauri::AppHandle, _root: &Path) -> Result<BridgeHost> { Err("本机 MCP 通道目前支持 macOS。".into()) }
#[cfg(not(unix))]
pub fn call(_root: &Path, _name: &str, _value: &Value) -> Result<Value> { Err("本机 MCP 通道目前支持 macOS。".into()) }

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn accepted_stream_waits_for_complete_large_response() {
        let (mut server, client) = UnixStream::pair().unwrap();
        server.set_nonblocking(true).unwrap();
        prepare_stream(&server).unwrap();
        let payload = vec![b'x'; 512 * 1024];
        let expected = payload.clone();
        let receiver = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            read_line(&mut BufReader::new(client), MAX_RESPONSE).unwrap()
        });
        server.write_all(&payload).unwrap();
        server.write_all(b"\n").unwrap();
        let received = receiver.join().unwrap();
        assert_eq!(&received[..received.len()-1], expected);
        assert_eq!(received.last(), Some(&b'\n'));
    }

    #[test]
    fn line_limit_rejects_oversize_messages() {
        assert!(read_line(&mut BufReader::new(&b"12345\n"[..]), 5).is_err());
        assert_eq!(read_line(&mut BufReader::new(&b"1234\n"[..]), 5).unwrap(), b"1234\n");
    }
}
