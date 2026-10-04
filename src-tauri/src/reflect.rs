//! Explicit, bounded local retrieval and human-confirmed idea storage.
use crate::store::{Annotation, Book, Store};
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::{Component, Path, PathBuf}, time::{Duration, Instant}};
type Result<T> = std::result::Result<T, String>;
fn err(e: impl std::fmt::Display) -> String { format!("回顾操作未完成：{e}") }
fn hash(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn clip(s: &str, n: usize) -> String { s.chars().take(n).collect() }
fn normal(s: &str) -> String { s.split_whitespace().collect::<Vec<_>>().join(" ") }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Location { pub book_id: String, pub fingerprint: String, pub cfi: String, pub href: String }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub id: String, pub kind: String, pub key: String, pub title: String, pub text: String,
    pub content_hash: String, pub truncated: bool, pub location: Option<Location>,
    pub vault_path: Option<String>, pub relative_path: Option<String>, pub start_line: Option<usize>, pub end_line: Option<usize>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Citation { pub source: Source, pub quote: String }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Idea {
    pub id: String, pub title: String, pub body: String, pub question: String,
    pub created_by: String, pub confirmed_by: String, pub created_at: String, pub confirmed_at: String, pub sources: Vec<Citation>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveIdea { pub id: String, pub title: String, pub body: String, pub question: String, pub sources: Vec<Citation> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult { pub sources: Vec<Source>, pub limited: bool, pub message: String }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope { pub vault_path: String, pub path: String }

pub fn assistant_source(message: &crate::assistant::Message, source: &crate::assistant::Source) -> Source {
    Source { id:source.id.clone(), kind:"assistant".into(), key:format!("{}|{}",message.id,source.id),
        title:source.title.clone(), text:source.text.clone(), content_hash:source.version.clone(), truncated:source.truncated,
        location:source.anchor.as_ref().filter(|_|!source.book_id.is_empty()).map(|a|Location {book_id:source.book_id.clone(),fingerprint:source.book_id.clone(),cfi:a.cfi.clone(),href:a.href.clone()}),
        vault_path:if source.kind=="vault" {message.input.retrieval.as_ref().and_then(|r|r.vault_root.clone())} else {None},
        relative_path:if source.kind=="vault" {Some(source.fingerprint.clone())} else {None}, start_line:None,end_line:None }
}

fn excerpt(text: &str, query: &str) -> (String, usize, usize) {
    let at = if query.is_empty() { 0 } else { text.to_ascii_lowercase().find(&query.to_ascii_lowercase()).unwrap_or(0) };
    let start_chars = text[..at].chars().count().saturating_sub(160);
    let start = text.char_indices().nth(start_chars).map(|v|v.0).unwrap_or(0);
    let result: String = text[start..].chars().take(900).collect();
    let line = 1 + text[..start].bytes().filter(|b|*b == b'\n').count();
    let end = line + result.bytes().filter(|b|*b == b'\n').count();
    (result,line,end)
}
fn matches(text: &str, query: &str) -> bool { query.is_empty() || text.to_ascii_lowercase().contains(&query.to_ascii_lowercase()) }
fn note_text(note: &Annotation) -> String { format!("{}\n原文摘录：{}",note.body,note.quote) }
pub(crate) fn safe_path(root: &Path, relative: &str) -> Result<PathBuf> {
    if relative.len() > 2048 || relative.is_empty() { return Err("来源路径无效。".into()); }
    let mut path = root.to_path_buf();
    for part in Path::new(relative).components() {
        let Component::Normal(name) = part else { return Err("来源路径超出允许范围。".into()); };
        if name.to_string_lossy().starts_with('.') { return Err("不读取隐藏文件或目录。".into()); }
        path.push(name);
        if fs::symlink_metadata(&path).map_err(err)?.file_type().is_symlink() { return Err("不读取符号链接来源。".into()); }
    }
    if fs::canonicalize(&path).map_err(err)? != path { return Err("来源位置已改变。".into()); }
    Ok(path)
}
pub(crate) fn read_markdown(path: &Path) -> Result<(String, String)> {
    if !path.extension().is_some_and(|v|v.to_string_lossy().eq_ignore_ascii_case("md")) { return Err("只读取 Markdown 来源。".into()); }
    let metadata = fs::symlink_metadata(path).map_err(err)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 128 * 1024 { return Err("来源不是允许大小的普通 Markdown 文件。".into()); }
    let mut file = fs::File::open(path).map_err(err)?;
    let mut bytes = Vec::new(); (&mut file).take(128 * 1024 + 1).read_to_end(&mut bytes).map_err(err)?;
    if bytes.len() > 128 * 1024 || fs::canonicalize(path).map_err(err)? != path { return Err("来源在读取时发生变化。".into()); }
    let digest = hash(&bytes); let text = String::from_utf8(bytes).map_err(|_| "Markdown 来源不是 UTF-8。".to_string())?;
    Ok((text,digest))
}
impl Store {
    pub fn reflect_scope(&self) -> Result<Option<Scope>> {
        let raw: Option<String> = self.db.query_row("SELECT data FROM settings WHERE key='reflect_scope'",[],|r|r.get(0)).optional().map_err(err)?;
        let scope: Option<Scope> = raw.map(|v|serde_json::from_str(&v).map_err(err)).transpose()?;
        Ok(scope.filter(|s| self.vault_config().ok().flatten().is_some_and(|v|v.path == s.vault_path)))
    }
    fn checked_scope(&self) -> Result<Option<(Scope, PathBuf)>> {
        let Some(scope) = self.reflect_scope()? else { return Ok(None); };
        let root = fs::canonicalize(&scope.vault_path).map_err(err)?;
        if root != Path::new(&scope.vault_path) || !root.join(".obsidian").is_dir() { return Err("Vault 位置已变化，请重新选择检索范围。".into()); }
        let relative = Path::new(&scope.path).strip_prefix(&root).map_err(|_|"检索范围超出 Vault。".to_string())?;
        let path = if relative.as_os_str().is_empty() { root } else { safe_path(&root,&relative.to_string_lossy())? };
        if !path.is_dir() { return Err("检索文件夹暂时不可用。".into()); }
        Ok(Some((scope,path)))
    }
    pub fn configure_reflect_scope(&self, path: Option<String>) -> Result<Option<Scope>> {
        let scope = if let Some(path) = path {
            let vault = self.vault_config()?.ok_or("请先连接 Obsidian Vault。")?;
            let root = fs::canonicalize(&vault.path).map_err(err)?;
            if root != Path::new(&vault.path) { return Err("Vault 位置已变化。".into()); }
            let selected = fs::canonicalize(path).map_err(err)?;
            let relative = selected.strip_prefix(&root).map_err(|_| "请选择当前 Vault 内的文件夹。".to_string())?;
            let checked = if relative.as_os_str().is_empty() { root.clone() } else { safe_path(&root,&relative.to_string_lossy())? };
            if !checked.is_dir() { return Err("请选择文件夹。".into()); }
            Some(Scope { vault_path:vault.path, path:checked.to_string_lossy().into_owned() })
        } else { None };
        match &scope {
            Some(s) => { self.db.execute("INSERT INTO settings(key,data) VALUES ('reflect_scope',?1) ON CONFLICT(key) DO UPDATE SET data=excluded.data",[serde_json::to_string(s).map_err(err)?]).map_err(err)?; }
            None => { self.db.execute("DELETE FROM settings WHERE key='reflect_scope'",[]).map_err(err)?; }
        }
        Ok(scope)
    }
    pub fn reflect_search(&self, query: String, book_id: Option<String>, include_vault: bool) -> Result<SearchResult> {
        let query = query.trim();
        if query.chars().count() > 100 { return Err("检索文字最多 100 字。".into()); }
        if let Some(id) = &book_id { if self.query_book(id)?.is_none() { return Err("书籍尚未导入。".into()); } }
        let mut sources = Vec::new(); let mut limited = false;
        let mut stmt = self.db.prepare("SELECT a.data,b.data FROM annotations a JOIN books b ON b.id=a.book_id WHERE deleted_at IS NULL AND json_extract(a.data,'$.kind')='note' AND coalesce(json_extract(a.data,'$.createdBy'),'human')='human' AND (?1 IS NULL OR a.book_id=?1) AND (?2='' OR instr(lower(json_extract(a.data,'$.body')),lower(?2))>0 OR instr(lower(json_extract(a.data,'$.quote')),lower(?2))>0) ORDER BY json_extract(a.data,'$.createdAt') DESC,a.id DESC LIMIT 9").map_err(err)?;
        let rows = stmt.query_map(params![book_id,query],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(err)?;
        for row in rows {
            if sources.len() == 8 { limited = true; break; }
            let (raw,book) = row.map_err(err)?; let note: Annotation = serde_json::from_str(&raw).map_err(err)?; let book: Book = serde_json::from_str(&book).map_err(err)?;
            let full = note_text(&note); let (text,_,_) = excerpt(&full,query);
            sources.push(Source { id:format!("reader-{}",note.id),kind:"reader".into(),key:note.id.clone(),title:clip(&format!("{} · {}",book.title,note.chapter_label),240),
                truncated:text.len()<full.len(),text,content_hash:hash(raw.as_bytes()),location:Some(Location {book_id:note.book_id,fingerprint:note.fingerprint,cfi:note.cfi,href:note.href}),
                vault_path:None,relative_path:None,start_line:None,end_line:None });
        }
        if include_vault {
            let (scope,folder) = self.checked_scope()?.ok_or("请先选择 Vault 检索文件夹。")?;
            let root = PathBuf::from(&scope.vault_path); let mut stack = vec![(folder,0)]; let mut seen = 0; let mut files = 0; let mut bytes = 0; let deadline = Instant::now()+Duration::from_secs(3);
            'scan: while let Some((dir,depth)) = stack.pop() {
                if fs::canonicalize(&dir).map_err(err)? != dir || fs::symlink_metadata(&dir).map_err(err)?.file_type().is_symlink() { continue; }
                for entry in fs::read_dir(&dir).map_err(err)? {
                    if seen >= 512 || files >= 128 || bytes >= 2 * 1024 * 1024 || Instant::now()>deadline || sources.len()>=16 { limited = true; break 'scan; }
                    seen += 1; let entry = entry.map_err(err)?; let name = entry.file_name();
                    if name.to_string_lossy().starts_with('.') { continue; }
                    let path = entry.path(); let metadata = fs::symlink_metadata(&path).map_err(err)?;
                    if metadata.file_type().is_symlink() { continue; }
                    if metadata.is_dir() { if depth < 6 { stack.push((path,depth+1)); } else { limited = true; } continue; }
                    if !metadata.is_file() || !path.extension().is_some_and(|v|v.to_string_lossy().eq_ignore_ascii_case("md")) { continue; }
                    files += 1; if metadata.len()>128*1024 { limited=true; continue; } if bytes + metadata.len()>2 * 1024 * 1024 { limited=true; break 'scan; }
                    let relative = path.strip_prefix(&root).map_err(err)?.to_string_lossy().into_owned();
                    let checked = safe_path(&root,&relative)?;
                    let Ok((full,digest)) = read_markdown(&checked) else { limited=true; continue; };
                    bytes += full.len() as u64;
                    if bytes>2 * 1024 * 1024 { limited=true; break 'scan; }
                    if !matches(&full,query) { continue; }
                    let (text,start,end) = excerpt(&full,query);
                    sources.push(Source {id:format!("vault-{}",&hash(relative.as_bytes())[..24]),kind:"vault".into(),key:relative.clone(),title:clip(&relative,240),truncated:text.len()<full.len(),text,content_hash:digest,location:None,
                        vault_path:Some(scope.vault_path.clone()),relative_path:Some(relative),start_line:Some(start),end_line:Some(end) });
                }
            }
        }
        Ok(SearchResult {sources,limited,message:if limited {"只展示有限检索结果；可缩小关键词或文件夹。"} else {"检索完成；只有勾选的摘录会在分析时发送。"}.into()})
    }
    pub fn verify_reflect_sources(&self, sources: Vec<Source>) -> Result<Vec<Source>> {
        if sources.len() > 6 { return Err("最多选择 6 个来源。".into()); }
        let mut seen = std::collections::HashSet::new();
        for source in &sources {
            if !seen.insert(serde_json::to_string(source).map_err(err)?) { continue; }
            if source.text.trim().is_empty() || source.text.chars().count()>900 || source.title.chars().count()>240 || source.content_hash.len()!=64 { return Err("回顾来源无效。".into()); }
            if source.kind == "reader" {
                let raw: String = self.db.query_row("SELECT data FROM annotations WHERE id=?1 AND deleted_at IS NULL",[&source.key],|r|r.get(0)).map_err(|_|"来源笔记已删除，请重新检索。".to_string())?;
                let note: Annotation = serde_json::from_str(&raw).map_err(err)?;
                let location = source.location.as_ref().ok_or("来源缺少原文位置。")?;
                let book = self.query_book(&note.book_id)?.ok_or("来源书籍已删除。")?;
                if source.title != clip(&format!("{} · {}",book.title,note.chapter_label),240) || source.start_line.is_some() || source.end_line.is_some() || source.truncated != (source.text.len()<note_text(&note).len()) { return Err("来源元数据已变化，请重新检索。".into()); }
                if source.id != format!("reader-{}",note.id) || source.content_hash != hash(raw.as_bytes()) || note.kind != "note" || note.created_by != "human"
                    || !note_text(&note).contains(&source.text) || location.book_id != note.book_id || location.fingerprint != note.fingerprint || location.cfi != note.cfi || location.href != note.href
                    || source.vault_path.is_some() || source.relative_path.is_some() { return Err("来源笔记已改变，请重新检索。".into()); }
            } else if source.kind == "book" {
                let location = source.location.as_ref().ok_or("来源缺少原文位置。")?;
                let book = self.query_book(&location.book_id)?.ok_or("来源书籍已删除。")?;
                if location.fingerprint != book.fingerprint { return Err("书籍指纹不匹配。".into()); }
                if source.start_line.is_some() || source.end_line.is_some() || source.vault_path.is_some() || source.relative_path.is_some() { return Err("书内来源元数据无效。".into()); }
            } else if source.kind == "vault" {
                let (scope,folder) = self.checked_scope()?.ok_or("Vault 检索范围已断开。")?;
                let relative = source.relative_path.as_deref().ok_or("来源缺少文件路径。")?;
                let path = safe_path(Path::new(&scope.vault_path),relative)?;
                if source.vault_path.as_deref()!=Some(&scope.vault_path) || !path.starts_with(&folder) || source.key != relative || source.id != format!("vault-{}",&hash(relative.as_bytes())[..24]) || source.location.is_some() { return Err("来源超出 Vault 检索范围。".into()); }
                let (full,digest) = read_markdown(&path)?;
                if digest != source.content_hash || !full.contains(&source.text) || source.title != clip(relative,240) || source.truncated != (source.text.len()<full.len()) { return Err("Vault 来源已修改，请重新检索。".into()); }
                let start = source.start_line.ok_or("来源行号缺失。")?;
                let end = source.end_line.ok_or("来源行号缺失。")?;
                if start == 0 || end < start || !full.match_indices(&source.text).any(|(i,_)| 1+full[..i].bytes().filter(|b|*b==b'\n').count()==start && start+source.text.bytes().filter(|b|*b==b'\n').count()==end) { return Err("来源行号无效。".into()); }
            } else if source.kind == "assistant" {
                let (message_id, source_id) = source.key.split_once('|').ok_or("助手来源标识无效。")?;
                let path = self.data_root().join("assistant.sqlite3");
                let db = rusqlite::Connection::open_with_flags(path,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(err)?;
                let raw: String = db.query_row("SELECT data FROM messages WHERE id=?1",[message_id],|r|r.get(0)).map_err(err)?;
                let message: crate::assistant::Message = serde_json::from_str(&raw).map_err(err)?;
                let original = message.input.sources.iter().find(|s|s.id==source_id).ok_or("助手来源不存在。")?;
                if message.status != "completed" || message.role != "assistant" || !message.answer.as_ref().is_some_and(|a|a.citations.iter().any(|c|c.source_id==source_id))
                    || serde_json::to_value(assistant_source(&message, original)).map_err(err)? != serde_json::to_value(source).map_err(err)? {
                    return Err("助手来源与已保存答复不一致。".into());
                }
            } else { return Err("来源类别无效。".into()); }
        }
        Ok(sources)
    }
    pub fn reflect_source_path(&self, source: Source) -> Result<PathBuf> {
        self.verify_reflect_sources(vec![source.clone()])?;
        if source.kind == "assistant" {
            let scope = crate::library::resolve_vault_scope(self).ok_or("Vault 已断开或不可用。")?;
            if source.vault_path.as_deref() != scope.vault_path.to_str() { return Err("来源属于之前的 Vault，请重新连接原 Vault。".into()); }
            let path = safe_path(&scope.vault_path,source.relative_path.as_deref().ok_or("这不是 Vault 文件来源。")?)?;
            if !path.starts_with(scope.search_dir) { return Err("来源超出当前检索范围。".into()); }
            return Ok(path);
        }
        if source.kind != "vault" { return Err("这不是 Vault 文件来源。".into()); }
        safe_path(Path::new(source.vault_path.as_deref().unwrap()),source.relative_path.as_deref().unwrap())
    }
    pub fn ideas(&self) -> Result<Vec<Idea>> { self.all("SELECT data FROM ideas ORDER BY json_extract(data,'$.createdAt') DESC LIMIT 100") }
    pub fn idea(&self, id: &str) -> Result<Idea> {
        let raw: String = self.db.query_row("SELECT data FROM ideas WHERE id=?1",[id],|r|r.get(0)).map_err(err)?;
        serde_json::from_str(&raw).map_err(err)
    }
    pub fn save_idea(&self, draft: SaveIdea) -> Result<Idea> {
        if draft.id.len()!=36 || !draft.id.bytes().all(|b|b.is_ascii_hexdigit() || b==b'-') || draft.title.trim().is_empty() || draft.title.chars().count()>80 || draft.body.trim().is_empty() || draft.body.chars().count()>4000 || draft.question.chars().count()>500 { return Err("想法标题或正文无效。".into()); }
        if let Ok(existing) = self.idea(&draft.id) {
            if existing.title == draft.title.trim() && existing.body == draft.body.trim() && existing.question == draft.question && serde_json::to_value(&existing.sources).map_err(err)? == serde_json::to_value(&draft.sources).map_err(err)? { return Ok(existing); }
            return Err("该想法已保存，请勿复用标识。".into());
        }
        let note_exists: bool = self.db.query_row("SELECT EXISTS(SELECT 1 FROM annotations WHERE id=?1)",[&draft.id],|r|r.get(0)).map_err(err)?;
        if note_exists { return Err("想法标识与笔记冲突。".into()); }
        self.verify_reflect_sources(draft.sources.iter().map(|c|c.source.clone()).collect())?;
        for citation in &draft.sources {
            let quote = normal(&citation.quote);
            if quote.chars().count()<2 || quote.chars().count()>160 || !normal(&citation.source.text).contains(&quote) { return Err("想法引用未通过原文核对。".into()); }
        }
        let date = Utc::now().to_rfc3339();
        let idea = Idea {id:draft.id,title:draft.title.trim().into(),body:draft.body.trim().into(),question:draft.question,created_by:"agent".into(),confirmed_by:"human".into(),created_at:date.clone(),confirmed_at:date,sources:draft.sources};
        let raw = serde_json::to_string(&idea).map_err(err)?;
        if raw.len()>64*1024 { return Err("想法超出保存范围。".into()); }
        self.db.execute("INSERT INTO ideas(id,data) VALUES (?1,?2)",params![idea.id,raw]).map_err(err)?; Ok(idea)
    }
}
