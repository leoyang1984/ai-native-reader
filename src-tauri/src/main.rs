#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod bridge;
mod context;
mod codex;
mod agent;
mod pi;
mod assistant;
mod library;
#[cfg(debug_assertions)]
mod assistant_check;
mod mcp;
mod query;
mod reflect;
mod service;
mod store;
mod vault;
use std::{path::Path, sync::{Mutex, atomic::{AtomicBool, Ordering}}};
use context::{ContextHub, ContextSnapshot, ReadingContext};
use store::{Annotation, Book, Position, Session, Settings, Snapshot, Store};
use tauri::{Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use vault::{ExportRecord, VaultState};
use service::{Database, RuntimeContext, locked, context_locked};
use serde_json::Value;
use sha2::Digest;

type Result<T> = std::result::Result<T, String>;
fn reader_data_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf> {
    if cfg!(debug_assertions) {
        if let Some(root) = std::env::var_os("AINATIVE_READER_DATA_DIR") { return Ok(root.into()); }
    }
    app.path().app_data_dir().map_err(|_|"Reader 数据目录不可用。".into())
}
fn action_target_id(action: &str) -> String {
    let bytes = sha2::Sha256::digest(action.as_bytes());
    let hex = format!("{:x}",bytes);
    format!("{}-{}-{}-{}-{}",&hex[..8],&hex[8..12],&hex[12..16],&hex[16..20],&hex[20..32])
}
fn checked_receipt(service: &assistant::AssistantService, action: &str, kind: &str, hash: &str) -> Result<Option<assistant::ActionReceipt>> {
    let receipt = service.get_action_receipt(action)?;
    if receipt.as_ref().is_some_and(|r|r.action_type!=kind || r.content_hash!=hash) {
        return Err("此内容已保存，请勿重复保存不同版本。".into());
    }
    Ok(receipt)
}
struct ExitApproval(AtomicBool);

#[tauri::command]
fn snapshot(db: State<Database>) -> Result<Snapshot> { locked(&db)?.snapshot() }
#[tauri::command]
async fn read_import_file(path: String) -> Result<tauri::ipc::Response> { store::read_epub(Path::new(&path)).map(tauri::ipc::Response::new) }
#[tauri::command]
async fn import_book(db: State<'_, Database>, book: Book, source_path: String) -> Result<()> { locked(&db)?.import(&book, Path::new(&source_path)) }
#[tauri::command]
fn read_sample_file() -> tauri::ipc::Response { tauri::ipc::Response::new(include_bytes!("../../public/samples/reader-lab.epub").to_vec()) }
#[tauri::command]
fn import_sample(db: State<Database>, book: Book) -> Result<()> { locked(&db)?.import_bytes(&book, include_bytes!("../../public/samples/reader-lab.epub")) }
#[tauri::command]
async fn load_book(db: State<'_, Database>, id: String) -> Result<tauri::ipc::Response> { locked(&db)?.load(&id).map(tauri::ipc::Response::new) }
#[tauri::command]
fn save_position(db: State<Database>, position: Position) -> Result<()> { locked(&db)?.save_position(&position) }
#[tauri::command]
fn save_annotation(db: State<Database>, annotation: Annotation) -> Result<()> { locked(&db)?.save_annotation(&annotation) }
#[tauri::command]
fn delete_annotation(db: State<Database>, id: String) -> Result<()> { locked(&db)?.delete_annotation(&id) }
#[tauri::command]
fn save_session(db: State<Database>, session: Session) -> Result<()> { locked(&db)?.save_session(&session) }
#[tauri::command]
fn save_settings(db: State<Database>, settings: Settings) -> Result<()> { locked(&db)?.save_settings(&settings) }
#[tauri::command]
fn vault_state(db: State<Database>) -> Result<VaultState> { locked(&db)?.vault_state() }
#[tauri::command]
async fn configure_vault(app: tauri::AppHandle, db: State<'_, Database>, path: Option<String>) -> Result<VaultState> {
    let state=locked(&db)?.configure_vault(path)?;
    let index_path=reader_data_root(&app)?.join("assistant-library.sqlite3");
    if index_path.exists() {
        library::VaultIndex::open(&index_path).and_then(|mut index|index.clear()).map_err(|e|format!("Vault 配置已更新，但本地检索缓存清理失败：{e}"))?;
    }
    Ok(state)
}
#[tauri::command]
async fn export_note(db: State<'_, Database>, id: String) -> Result<ExportRecord> { locked(&db)?.export_note(&id) }
#[tauri::command]
async fn open_export(app: tauri::AppHandle, db: State<'_, Database>, id: String, copy: bool) -> Result<()> {
    let path = locked(&db)?.exported_path(&id, copy)?;
    app.opener().open_url(vault::obsidian_url(&path), None::<&str>)
        .map_err(|e| format!("无法打开 Obsidian：{e}。请先在 Obsidian 中打开所选 Vault。"))
}
#[tauri::command]
fn begin_reading_context(state: State<RuntimeContext>, instance_id: String) -> Result<()> { context_locked(&state)?.begin(instance_id) }
#[tauri::command]
fn publish_reading_context(db: State<Database>, state: State<RuntimeContext>, context: ReadingContext) -> Result<()> {
    // Keep this lock order when the MCP transport is added.
    let mut hub = context_locked(&state)?;
    let store = locked(&db)?;
    context.validate(&store)?;
    hub.publish(context.clone())?;
    store.save_reading_context(&context)
}
#[tauri::command]
fn get_reading_context(state: State<RuntimeContext>) -> Result<ContextSnapshot> { Ok(context_locked(&state)?.snapshot()) }
#[tauri::command]
fn get_saved_reading_context(db: State<Database>) -> Result<ContextSnapshot> { Ok(ContextSnapshot::persisted(locked(&db)?.last_reading_context()?)) }
#[tauri::command]
fn complete_mcp_request(state: State<bridge::FrontendRequests>, id: String, result: Option<Value>, error: Option<String>) -> Result<()> {
    state.complete(id,result,error)
}
#[tauri::command]
fn codex_status(host: State<agent::AgentHost>) -> Result<Value> { host.status() }
#[tauri::command]
async fn agent_select(host: State<'_, agent::AgentHost>, provider: String) -> Result<Value> {
    let host=host.shared();
    tauri::async_runtime::spawn_blocking(move || host.select(provider)).await.map_err(|_|"助手选择任务失败。".to_string())?
}
#[tauri::command]
async fn codex_connect(host: State<'_, agent::AgentHost>, executable: String) -> Result<Value> {
    let host = host.shared();
    tauri::async_runtime::spawn_blocking(move || host.connect(executable)).await.map_err(|_| "助手连接任务失败。".to_owned())?
}
#[tauri::command]
async fn codex_start(host: State<'_, agent::AgentHost>, request_id: String, text: String, fresh: bool, generation: u64, output_schema: Option<Value>) -> Result<()> {
    let host = host.shared();
    tauri::async_runtime::spawn_blocking(move || host.start(request_id, text, fresh, generation, output_schema)).await.map_err(|_| "助手提问任务失败。".to_owned())?
}
#[tauri::command]
async fn codex_cancel(host: State<'_, agent::AgentHost>, request_id: String) -> Result<()> {
    let host = host.shared();
    tauri::async_runtime::spawn_blocking(move || host.cancel(request_id)).await.map_err(|_| "助手取消任务失败。".to_owned())?
}
#[tauri::command]
async fn codex_disconnect(host: State<'_, agent::AgentHost>) -> Result<()> {
    let host = host.shared();
    tauri::async_runtime::spawn_blocking(move || host.disconnect()).await.map_err(|_| "助手断开任务失败。".to_owned())
}
#[tauri::command]
async fn assistant_create(service: State<'_, assistant::AssistantService>, id: String, title: String, book_id: Option<String>) -> Result<assistant::Conversation> {
    let service=service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.create(id,title,book_id)).await.map_err(|_|"助手记录任务失败。".to_string())?
}
#[tauri::command]
async fn assistant_list(service: State<'_, assistant::AssistantService>, before: Option<String>) -> Result<Vec<assistant::Conversation>> {
    let service=service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.list(before)).await.map_err(|_|"助手记录任务失败。".to_string())?
}
#[tauri::command]
async fn assistant_load(service: State<'_, assistant::AssistantService>, id: String, before: Option<i64>) -> Result<assistant::Page> {
    let service=service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.load(&id,before)).await.map_err(|_|"助手记录任务失败。".to_string())?
}
#[tauri::command]
async fn assistant_draft(service: State<'_, assistant::AssistantService>, id: String, text: String) -> Result<()> {
    let service=service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.draft(&id,&text)).await.map_err(|_|"助手记录任务失败。".to_string())?
}
#[tauri::command]
async fn assistant_capture_selection(app: tauri::AppHandle, service: State<'_, assistant::AssistantService>, context: State<'_, RuntimeContext>, conversation_id: String, note_id: Option<String>) -> Result<assistant::Source> {
    let source = if let Some(note_id) = note_id {
        let binding = app.state::<Database>(); let db = locked(&binding)?;
        let raw: String = db.db.query_row("SELECT data FROM annotations WHERE id=?1 AND deleted_at IS NULL",[note_id],|r|r.get(0)).map_err(|_|"笔记已删除。")?;
        let note: Annotation = serde_json::from_str(&raw).map_err(|_|"笔记数据无效。")?;
        let book = db.query_book(&note.book_id)?.ok_or("来源书籍已删除。")?;
        if note.quote.chars().count()>900 { return Err("引用太长，请在原文中缩小选区。".into()); }
        assistant::Source::book(book.id,book.title,note.quote,false,Some(assistant::Anchor {cfi:note.cfi,href:note.href}))
    } else {
        let snapshot = context_locked(&context)?.snapshot();
        if snapshot.is_stale || !snapshot.current.as_ref().is_some_and(|c|c.selection.is_some()) { return Err("选区已经变化，请重新选中原文。".into()); }
        assistant::Input::capture("引用".into(),snapshot).sources.into_iter().next().ok_or("没有可引用的原文。")?
    };
    service.set_attachment(&conversation_id,Some(source.clone()))?;
    Ok(source)
}
#[tauri::command]
async fn assistant_copy_attachment(service: State<'_, assistant::AssistantService>, from: String, to: String) -> Result<()> { service.set_attachment(&to,service.attachment(&from)?) }
#[tauri::command]
async fn assistant_clear_attachment(service: State<'_, assistant::AssistantService>, conversation_id: String) -> Result<()> { service.set_attachment(&conversation_id,None) }
#[tauri::command]
async fn assistant_action_drafts(service: State<'_, assistant::AssistantService>, conversation_id: String, drafts: Vec<assistant::ActionDraft>) -> Result<()> { service.save_action_drafts(&conversation_id,drafts) }
#[tauri::command]
async fn assistant_start(app: tauri::AppHandle, host: State<'_, agent::AgentHost>, context: State<'_, RuntimeContext>, conversation_id: String, request_id: String, question: String, generation: u64) -> Result<()> {
    // Take one trusted runtime snapshot, never accept model/frontend-provided paths.
    let snapshot = context_locked(&context)?.snapshot();
    let current_book_id = snapshot.current.as_ref().and_then(|c| c.book.as_ref()).map(|b| b.id.clone());
    let mut input = assistant::Input::capture(question.clone(), snapshot);
    if let Some(source) = app.state::<assistant::AssistantService>().attachment(&conversation_id)? {
        input.sources.retain(|s|s.id != source.id);
        if input.context.book_id.as_deref()!=Some(&source.book_id) {input.context.chapter=None;}
        input.context.book_id = Some(source.book_id.clone());
        input.sources.insert(0,source);
    }

    let root = reader_data_root(&app)?;
    let host = host.shared();
    tauri::async_runtime::spawn_blocking(move || {
        // A separate query-only connection avoids holding the reading/write lock during a Vault scan.
        if let Some(db) = Store::open_readonly(&root)? {
            let scope = library::resolve_vault_scope(&db);
            let result = library::search_local_library(&db, &question, current_book_id.as_deref(), Some(&root.join("assistant-library.sqlite3")));
            let books = std::mem::take(&mut input.sources);
            input.sources.extend(books.iter().take(2).cloned());
            for kind in ["note","idea","vault"] {
                if let Some(source) = result.sources.iter().find(|s|s.kind == kind) { input.sources.push(source.clone()); }
            }
            for source in result.sources.iter().chain(books.iter()) {
                if input.sources.len()<6 && !input.sources.iter().any(|s|s.id==source.id) { input.sources.push(source.clone()); }
            }
            input.retrieval = Some(assistant::Retrieval {scope:result.coverage_scope,matched:result.matched_count,
                sent:input.sources.iter().filter(|s|s.kind!="book").count(),partial:result.partial,
                vault_root:scope.map(|v|v.vault_path.to_string_lossy().into_owned())});
        }
    while input.prompt().is_err() && !input.sources.is_empty() {
        input.sources.pop();
        input.truncated = true;
    }
    input.truncated |= input.sources.iter().any(|s| s.truncated);

        if let Some(retrieval) = &mut input.retrieval { retrieval.sent = input.sources.iter().filter(|s|s.kind!="book").count(); }
        host.start_assistant(conversation_id,request_id,input,generation)
    }).await.map_err(|_|"讨论任务失败。".to_string())?
}
#[tauri::command]
fn reflect_scope(db: State<Database>) -> Result<Option<reflect::Scope>> { locked(&db)?.reflect_scope() }
#[tauri::command]
async fn configure_reflect_scope(db: State<'_, Database>, path: Option<String>) -> Result<Option<reflect::Scope>> { locked(&db)?.configure_reflect_scope(path) }
#[tauri::command]
async fn reflect_search(app: tauri::AppHandle, query: String, book_id: Option<String>, include_vault: bool) -> Result<reflect::SearchResult> {
    tauri::async_runtime::spawn_blocking(move || locked(&app.state::<Database>())?.reflect_search(query,book_id,include_vault)).await.map_err(|_|"检索任务失败。".to_string())?
}
#[tauri::command]
async fn verify_reflect_sources(app: tauri::AppHandle, sources: Vec<reflect::Source>) -> Result<Vec<reflect::Source>> {
    tauri::async_runtime::spawn_blocking(move || locked(&app.state::<Database>())?.verify_reflect_sources(sources)).await.map_err(|_|"来源核对失败。".to_string())?
}
#[tauri::command]
fn list_ideas(db: State<Database>) -> Result<Vec<reflect::Idea>> { locked(&db)?.ideas() }
#[tauri::command]
async fn save_idea(app: tauri::AppHandle, draft: reflect::SaveIdea) -> Result<reflect::Idea> {
    tauri::async_runtime::spawn_blocking(move || locked(&app.state::<Database>())?.save_idea(draft)).await.map_err(|_|"想法保存失败。".to_string())?
}
#[tauri::command]
async fn export_idea(db: State<'_, Database>, id: String) -> Result<ExportRecord> { locked(&db)?.export_idea(&id) }
#[tauri::command]
async fn open_reflect_source(app: tauri::AppHandle, db: State<'_, Database>, source: reflect::Source) -> Result<()> {
    let path = locked(&db)?.reflect_source_path(source)?;
    app.opener().open_url(vault::obsidian_url(&path),None::<&str>).map_err(|_|"无法打开 Obsidian 来源。".to_string())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantSaveNoteDraft {
    pub note_id: String,
    pub action_id: String,
    pub conversation_id: String,
    pub message_id: Option<String>,
    pub body: String,
    pub quote: String,
    pub anchor: Option<assistant::Anchor>,
    pub book_id: Option<String>,
    pub export_to_vault: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantSaveIdeaDraft {
    pub action_id: String,
    pub conversation_id: String,
    pub message_id: String,
    pub draft: reflect::SaveIdea,
    pub export_to_vault: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantSaveIdeaResult {
    pub idea: reflect::Idea,
    pub receipt: assistant::ActionReceipt,
    pub exported: bool,
    pub export_message: Option<String>,
}

#[tauri::command]
async fn assistant_save_note(
    app: tauri::AppHandle,
    assistant: State<'_, assistant::AssistantService>,
    draft: AssistantSaveNoteDraft,
) -> Result<assistant::SaveNoteResult> {
    let assistant = assistant.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let message_id = draft.message_id.as_deref().ok_or("请从对话中的原话保存笔记。")?;
        let message = assistant.message(&draft.conversation_id,message_id)?;
        if message.role != "user" || message.status != "completed" { return Err("AI 草稿请通过确认想法保存。".into()); }
        if draft.action_id != format!("note-{}",message.id) || draft.body.trim().is_empty() || draft.body.chars().count()>8000 || draft.quote.chars().count()>4000 {
            return Err("笔记内容或保存标识无效。".into());
        }
        let id = action_target_id(&draft.action_id);
        let anchor = if let Some(anchor) = &draft.anchor {
            let source = message.input.sources.iter().find(|s|s.kind=="book" && s.book_id==draft.book_id.as_deref().unwrap_or("") && s.anchor.as_ref().is_some_and(|a|a.cfi==anchor.cfi && a.href==anchor.href))
                .ok_or("阅读位置不属于这条原话，请重新选择来源。")?;
            if source.truncated || source.text != draft.quote { return Err("原文摘录与绑定来源不一致，请使用完整摘录或保存独立对话笔记。".into()); }
            Some(source)
        } else { None };
        let kind = if anchor.is_some() {"book_annotation"} else {"conversation_note"};
        let content_hash = format!("{:x}",sha2::Sha256::digest(serde_json::to_vec(&(draft.body.trim(),draft.quote.trim(),&draft.book_id,&draft.anchor)).map_err(|_|"笔记内容无效。")?));
        let mut receipt = checked_receipt(&assistant,&draft.action_id,kind,&content_hash)?;
        let db_binding = app.state::<Database>(); let db = locked(&db_binding)?;
        if receipt.is_none() {
            if let Some(source) = anchor {
                let book = db.query_book(&source.book_id)?.ok_or("来源书籍已删除。")?;
                let note = store::Annotation { id:id.clone(),book_id:book.id,fingerprint:book.fingerprint,cfi:source.anchor.as_ref().unwrap().cfi.clone(),href:source.anchor.as_ref().unwrap().href.clone(),
                    body:draft.body.trim().into(),quote:draft.quote.clone(),kind:"note".into(),created_by:"human".into(),session_id:String::new(),
                    chapter_label:message.input.context.chapter.clone().unwrap_or_default(),created_at:chrono::Utc::now().to_rfc3339(),updated_at:chrono::Utc::now().to_rfc3339() };
                db.save_annotation(&note)?;
            } else {
                let note = assistant::ConversationNote {id:id.clone(),conversation_id:draft.conversation_id.clone(),message_id:Some(message.id.clone()),body:draft.body.trim().into(),quote:draft.quote.trim().into(),created_at:chrono::Utc::now().to_rfc3339()};
                // The service atomically writes the conversation note and the matching receipt.
                assistant.save_conversation_note_with_hash(note,&draft.action_id,&content_hash)?;
            }
            let saved = assistant::ActionReceipt {action_id:draft.action_id.clone(),action_type:kind.into(),target_id:id.clone(),content_hash,created_at:chrono::Utc::now().to_rfc3339()};
            assistant.record_action_receipt(saved.clone())?; receipt=Some(saved);
        }
        let mut exported = false; let mut export_message = None;
        if draft.export_to_vault {
            let result = if kind=="book_annotation" {db.export_note(&id)} else {
                db.export_conversation_note(&assistant.get_conversation_note(&id)?.ok_or("笔记不存在。")?,&assistant)
            };
            match result {Ok(rec)=>{exported=rec.status=="synced";export_message=rec.message;},Err(e)=>export_message=Some(e)}
        }
        Ok(assistant::SaveNoteResult {note_id:id,kind:kind.into(),receipt:receipt.unwrap(),exported,export_message})
    }).await.map_err(|_|"保存笔记任务执行失败。".to_string())?
}

#[tauri::command]
async fn assistant_save_idea(
    app: tauri::AppHandle,
    assistant: State<'_, assistant::AssistantService>,
    draft: AssistantSaveIdeaDraft,
) -> Result<AssistantSaveIdeaResult> {
    let assistant = assistant.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let message = assistant.message(&draft.conversation_id,&draft.message_id)?;
        if message.role != "assistant" || message.status != "completed" || draft.action_id != format!("idea-{}",message.id) { return Err("只能确认这条已完成的 AI 草稿。".into()); }
        let sources = message.answer.as_ref().ok_or("答复尚未通过核对。")?.citations.iter().map(|c| {
            let source = message.input.sources.iter().find(|s|s.id==c.source_id).ok_or("答复来源缺失。")?;
            Ok(reflect::Citation {source:reflect::assistant_source(&message,source),quote:c.quote.clone()})
        }).collect::<Result<Vec<_>>>()?;
        let content_hash = format!("{:x}",sha2::Sha256::digest(serde_json::to_vec(&(draft.draft.title.trim(),draft.draft.body.trim(),&sources)).map_err(|_|"想法内容无效。")?));
        let receipt = checked_receipt(&assistant,&draft.action_id,"idea",&content_hash)?;
        let id = action_target_id(&draft.action_id);
        let db_binding = app.state::<Database>(); let db = locked(&db_binding)?;
        let idea = if receipt.is_some() {db.idea(&id)?} else {
            db.save_idea(reflect::SaveIdea {id,title:draft.draft.title,body:draft.draft.body,question:message.input.question.chars().take(500).collect(),sources})?
        };
        let receipt = receipt.unwrap_or(assistant::ActionReceipt {action_id:draft.action_id,action_type:"idea".into(),target_id:idea.id.clone(),content_hash,created_at:chrono::Utc::now().to_rfc3339()});
        assistant.record_action_receipt(receipt.clone())?;
        let mut exported = false; let mut export_message = None;
        if draft.export_to_vault { match db.export_idea(&idea.id) {Ok(rec)=>{exported=rec.status=="synced";export_message=rec.message;},Err(e)=>export_message=Some(e)} }
        Ok(AssistantSaveIdeaResult {idea,receipt,exported,export_message})
    }).await.map_err(|_|"想法保存任务执行失败。".to_string())?
}

#[tauri::command]
async fn assistant_open_vault(app: tauri::AppHandle, assistant: State<'_, assistant::AssistantService>, conversation_id: String, message_id: String, source_id: String) -> Result<()> {
    let message = assistant.message(&conversation_id,&message_id)?;
    let source = message.input.sources.iter().find(|s|s.id==source_id && s.kind=="vault").ok_or("没有对应的 Vault 来源。")?;
    let path = locked(&app.state::<Database>())?.reflect_source_path(reflect::assistant_source(&message,source))?;
    app.opener().open_url(vault::obsidian_url(&path),None::<&str>).map_err(|_|"无法打开 Obsidian 来源。".to_string())
}

#[tauri::command]
async fn assistant_export_conversation_note(
    app: tauri::AppHandle,
    assistant: State<'_, assistant::AssistantService>,
    id: String,
) -> Result<ExportRecord> {
    let assistant = assistant.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db_binding = app.state::<Database>();
        let db = locked(&db_binding)?;
        let note = assistant.get_conversation_note(&id)?
            .ok_or_else(|| "对话笔记不存在。".to_string())?;
        db.export_conversation_note(&note, &assistant)
    }).await.map_err(|_| "导出对话笔记任务执行失败。".to_string())?
}

#[tauri::command]
fn finish_exit(app: tauri::AppHandle, approval: State<ExitApproval>, state: State<RuntimeContext>) -> Result<()> { context_locked(&state)?.stop(); if let Some(host) = app.try_state::<bridge::BridgeHost>() { host.stop(); } if let Some(host) = app.try_state::<agent::AgentHost>() { host.shutdown(); } approval.0.store(true, Ordering::Release); app.exit(0); Ok(()) }

fn main() {
    #[cfg(debug_assertions)]
    if std::env::args().nth(1).as_deref()==Some("--assistant-check-resume") {
        let result=std::env::args().nth(2).ok_or("缺少验收目录。".to_string()).and_then(|root|assistant_check::resume(Path::new(&root)));
        if let Err(error)=result {eprintln!("{error}");std::process::exit(1);}return;
    }
    #[cfg(debug_assertions)]
    if std::env::args().skip(1).any(|arg|arg=="--assistant-check") {
        if let Err(error)=assistant_check::run() {eprintln!("{error}");std::process::exit(1);}
        return;
    }
    if std::env::args().skip(1).any(|arg| arg == "--mcp") {
        if let Err(error) = bridge::data_root().and_then(mcp::run_stdio) { eprintln!("{error}"); std::process::exit(1); }
        return;
    }
    let mut app_context = tauri::generate_context!();
    // A debug acceptance root gets its own WebKit store as well as its own SQLite data.
    if cfg!(debug_assertions) {
        if let Some(root) = std::env::var_os("AINATIVE_READER_DATA_DIR") {
            let digest = sha2::Sha256::digest(root.to_string_lossy().as_bytes());
            for window in &mut app_context.config_mut().app.windows { window.data_store_identifier=Some(digest[..16].try_into().expect("WebKit store ID")); }
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") { let _ = window.set_focus(); }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let root = if cfg!(debug_assertions) {
                std::env::var_os("AINATIVE_READER_DATA_DIR").map(std::path::PathBuf::from).unwrap_or(app.path().app_data_dir()?)
            } else { app.path().app_data_dir()? };
            let db = Store::open(&root).map_err(std::io::Error::other)?;
            let last_context = db.last_reading_context().unwrap_or(None);
            app.manage(RuntimeContext(Mutex::new(ContextHub::new(last_context))));
            app.manage(Database(Mutex::new(db)));
            let assistant=assistant::AssistantService::open(&root);
            app.manage(agent::AgentHost::new(app.handle().clone(), &root, assistant.clone()).map_err(std::io::Error::other)?);
            app.manage(assistant);
            app.manage(bridge::FrontendRequests::new());
            let host = bridge::start(app.handle().clone(), &root).map_err(std::io::Error::other)?;
            app.manage(host);
            app.manage(ExitApproval(AtomicBool::new(false)));
            #[cfg(target_os = "macos")]
            {
                // The predefined macOS Quit item calls NSApplication terminate
                // directly, bypassing Tauri's preventable ExitRequested event.
                // Keep the standard menus but route Cmd-Q through our save flow.
                use tauri::menu::{Menu, MenuItem, MenuItemKind};
                let menu = Menu::default(app.handle())?;
                if let Some(MenuItemKind::Submenu(application_menu)) = menu.items()?.first() {
                    let count = application_menu.items()?.len();
                    application_menu.remove_at(count - 1)?;
                    application_menu.append(&MenuItem::with_id(app, "reader-quit", "Quit AI Native Reader", true, Some("CmdOrCtrl+Q"))?)?;
                }
                app.set_menu(menu)?;
                app.on_menu_event(|app, event| {
                    if event.id().as_ref() == "reader-quit" {
                        let _ = app.emit("reader-exit-requested", ());
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![snapshot, read_import_file, import_book, read_sample_file, import_sample, load_book, save_position, save_annotation, delete_annotation, save_session, save_settings, vault_state, configure_vault, export_note, open_export, begin_reading_context, publish_reading_context, get_reading_context, get_saved_reading_context, complete_mcp_request, codex_status, agent_select, codex_connect, codex_start, codex_cancel, codex_disconnect, assistant_create, assistant_list, assistant_load, assistant_draft, assistant_capture_selection, assistant_clear_attachment, assistant_copy_attachment, assistant_action_drafts, assistant_start, assistant_save_note, assistant_save_idea, assistant_open_vault, assistant_export_conversation_note, reflect_scope, configure_reflect_scope, reflect_search, verify_reflect_sources, list_ideas, save_idea, export_idea, open_reflect_source, finish_exit])
        .build(app_context)
        .expect("Reader 启动失败")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(host) = app.try_state::<agent::AgentHost>() { host.shutdown(); }
                if let Some(host) = app.try_state::<bridge::BridgeHost>() { host.stop(); }
                if let Ok(mut hub) = app.state::<RuntimeContext>().0.lock() { hub.stop(); }
            }
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !app.state::<ExitApproval>().0.load(Ordering::Acquire) && app.get_webview_window("main").is_some() {
                    api.prevent_exit();
                    let _ = app.emit("reader-exit-requested", ());
                }
            }
        });
}

#[cfg(test)]
mod acceptance_tests {
    use super::*;
    #[test]
    fn action_ids_are_durable_and_conflicting_confirmation_is_rejected() {
        assert_eq!(action_target_id("note-q-user"),action_target_id("note-q-user"));
        assert_ne!(action_target_id("note-q-user"),action_target_id("idea-q-assistant"));
        let dir=tempfile::tempdir().unwrap();let service=assistant::AssistantService::open(dir.path());
        service.record_action_receipt(assistant::ActionReceipt {action_id:"note-q-user".into(),action_type:"conversation_note".into(),target_id:"saved".into(),content_hash:"a".into(),created_at:chrono::Utc::now().to_rfc3339()}).unwrap();
        assert!(checked_receipt(&service,"note-q-user","conversation_note","a").unwrap().is_some());
        assert!(checked_receipt(&service,"note-q-user","conversation_note","different").is_err());
    }
    #[test]
    fn independent_note_export_journals_in_its_own_store_and_preserves_conflicts() {
        let dir=tempfile::tempdir().unwrap();let store=Store::open(dir.path()).unwrap();let service=assistant::AssistantService::open(dir.path());
        let vault=dir.path().join("vault");std::fs::create_dir_all(vault.join(".obsidian")).unwrap();store.configure_vault(Some(vault.to_string_lossy().to_string())).unwrap();
        service.create("discussion".into(),"独立讨论".into(),None).unwrap();
        let mut note=assistant::ConversationNote {id:action_target_id("independent"),conversation_id:"discussion".into(),message_id:None,body:"边界允许例外。".into(),quote:String::new(),created_at:chrono::Utc::now().to_rfc3339()};
        service.save_conversation_note(note.clone(),"saved").unwrap();
        let initial=store.export_conversation_note(&note,&service).unwrap();assert_eq!(initial.status,"synced");
        assert_eq!(store.export_conversation_note(&note,&service).unwrap().relative_path,initial.relative_path);
        assert_eq!(store.vault_state().unwrap().exports.len(),1);
        let index=dir.path().join("assistant-library.sqlite3");
        let result=library::search_local_library(&store,"「边界」",None,Some(&index));assert!(result.sources.iter().any(|s|s.kind=="note"));assert!(!result.sources.iter().any(|s|s.kind=="vault"));
        note.body="边界更新后的原话。".into();service.save_conversation_note(note.clone(),"edited").unwrap();
        let updated=store.export_conversation_note(&note,&service).unwrap();assert_eq!(updated.status,"synced");assert!(updated.backup_path.is_none());
        let path=std::path::Path::new(&updated.vault_path).join(&updated.relative_path);let external=b"external edit: boundary";std::fs::write(&path,external).unwrap();
        let conflict=store.export_conversation_note(&note,&service).unwrap();assert_eq!(conflict.status,"conflict");assert_eq!(std::fs::read(&path).unwrap(),external);
        let repeated=store.export_conversation_note(&note,&service).unwrap();assert_eq!(repeated.conflict_path,conflict.conflict_path);
        assert!(service.get_conversation_export(&updated.vault_path,&note.id).unwrap().is_some());
        assert_eq!(store.db.query_row("SELECT count(*) FROM vault_exports",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }
    #[test]
    fn mixed_frozen_citations_can_be_confirmed_and_fabrications_are_rejected() {
        let dir=tempfile::tempdir().unwrap();let store=Store::open(dir.path()).unwrap();let service=assistant::AssistantService::open(dir.path());
        service.create("discussion".into(),"测试".into(),None).unwrap();
        let mut input=assistant::Input::empty("比较边界".into());
        input.sources=vec![assistant::Source::note("human".into(),String::new(),"人工笔记".into(),String::new(),"边界帮助观察。".into(),false,None),assistant::Source::idea("idea".into(),"已确认".into(),"边界需要纠错。".into(),false),assistant::Source::vault("Materials/边界.md".into(),"边界是工具。".into(),false)];
        let input=service.begin("discussion","q",input).unwrap();
        let answer=serde_json::json!({"schemaVersion":1,"answer":"整理","citations":input.sources.iter().map(|s|serde_json::json!({"sourceId":s.id,"quote":s.text})).collect::<Vec<_>>(),"proposal":null});
        service.event("discussion","q","t",None,"completed",&answer.to_string(),"",1).unwrap();
        let message=service.message("discussion","q-assistant").unwrap();
        let sources=message.answer.as_ref().unwrap().citations.iter().map(|c|reflect::Citation {source:reflect::assistant_source(&message,input.sources.iter().find(|s|s.id==c.source_id).unwrap()),quote:c.quote.clone()}).collect::<Vec<_>>();
        let idea=store.save_idea(reflect::SaveIdea {id:action_target_id("idea-q-assistant"),title:"人工确认".into(),body:"已编辑的整理正文".into(),question:"比较边界".into(),sources}).unwrap();
        assert_eq!(idea.sources.len(),3); assert_eq!(idea.confirmed_by,"human");
        let mut forged=idea.sources[0].source.clone();forged.text="伪造来源".into();assert!(store.verify_reflect_sources(vec![forged]).is_err());
    }
}
