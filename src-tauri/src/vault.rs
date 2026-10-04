use crate::store::{Annotation, Book, Session, Store};
use chrono::{DateTime, Local, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::{Component, Path, PathBuf}};

type Result<T> = std::result::Result<T, String>;
fn err(e: impl std::fmt::Display) -> String { format!("导出未完成：{e}") }
fn hash(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn json<T: Serialize>(value: &T) -> Result<String> { serde_json::to_string(value).map_err(err) }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultConfig { pub path: String }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRecord {
    pub note_id: String,
    pub vault_path: String,
    pub relative_path: String,
    pub content_hash: Option<String>,
    pub source_hash: Option<String>,
    pub exported_at: Option<String>,
    pub status: String,
    pub message: Option<String>,
    pub conflict_path: Option<String>,
    pub backup_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultState { pub config: Option<VaultConfig>, pub exports: Vec<ExportRecord> }

fn safe_id(id: &str) -> Result<()> {
    if id.len() != 36 || !id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') {
        return Err("笔记 ID 无效，无法生成导出文件名。".into());
    }
    Ok(())
}

fn root(config: &VaultConfig) -> Result<PathBuf> {
    let path = Path::new(&config.path);
    let resolved = fs::canonicalize(path).map_err(|_| "Vault 暂时不可用。笔记已保存在 Reader，可在目录恢复后重试导出。".to_string())?;
    if resolved != path || !resolved.is_dir() || !resolved.join(".obsidian").is_dir() {
        return Err("Vault 的位置或目录状态已改变，请重新选择 Obsidian Vault。".into());
    }
    Ok(resolved)
}

fn child_dir(parent: &Path, name: &str) -> Result<PathBuf> {
    let child = parent.join(name);
    match fs::symlink_metadata(&child) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => return Err(format!("{name} 必须是 Vault 内的普通目录。")),
        Ok(_) => {},
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => fs::create_dir(&child).map_err(err)?,
        Err(error) => return Err(err(error)),
    }
    if fs::canonicalize(&child).map_err(err)? != child { return Err("导出目录不能指向 Vault 外部。".into()); }
    Ok(child)
}

fn file_path(vault: &Path, relative: &str, history: bool) -> Result<PathBuf> {
    let components: Vec<_> = Path::new(relative).components().collect();
    let required = if history { 3 } else { 2 };
    if components.len() != required || components.iter().any(|c| !matches!(c, Component::Normal(_)))
        || components[0].as_os_str() != "Reading" || (history && components[1].as_os_str() != ".reader-history") {
        return Err("导出记录中的文件位置无效。".into());
    }
    let reading = child_dir(vault, "Reading")?;
    let parent = if history { child_dir(&reading, ".reader-history")? } else { reading };
    Ok(parent.join(components[required - 1].as_os_str()))
}

fn read_file(path: &Path) -> Result<Option<Vec<u8>>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(err(error)),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() { return Err("导出文件必须是普通文件；不会跟随符号链接写入。".into()); }
    if metadata.len() > 2 * 1024 * 1024 { return Err("导出文件已超过 2 MB，Reader 已保留笔记并停止更新该文件。".into()); }
    fs::read(path).map(Some).map_err(err)
}

/// Publish a fully flushed temporary file without replacing an existing path.
fn publish_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or("导出目录无效。")?;
    let mut temporary = tempfile::Builder::new().prefix(".reader-write-").tempfile_in(parent).map_err(err)?;
    temporary.write_all(bytes).map_err(err)?;
    temporary.as_file().sync_all().map_err(err)?;
    temporary.persist_noclobber(path).map_err(|e| err(e.error))?;
    fs::File::open(parent).and_then(|d| d.sync_all()).map_err(err)?;
    Ok(())
}

fn value(s: &str) -> String { serde_json::to_string(s).expect("string serialization") }
fn heading(s: &str) -> String { s.replace(['\r', '\n'], " ").replace(['[', ']', '#'], "") }
fn encoded(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

pub fn reader_url(note: &Annotation) -> String {
    location_url(&note.book_id, &note.fingerprint, &note.cfi, &note.href, Some(&note.id))
}
pub fn location_url(book_id: &str, fingerprint: &str, cfi: &str, href: &str, note_id: Option<&str>) -> String {
    let note = note_id.map(|id|format!("&note={}",encoded(id))).unwrap_or_default();
    format!("ainativereader://open?book={}&fingerprint={}{}&cfi={}&href={}",
        encoded(book_id), encoded(fingerprint), note, encoded(cfi), encoded(href))
}

fn markdown(note: &Annotation, book: &Book, session: Option<&Session>) -> String {
    let chapter = if note.chapter_label.is_empty() { &note.href } else { &note.chapter_label };
    let mut fields = vec![
        ("created_by", "human".to_string()), ("source", "reader".to_string()), ("note_id", note.id.clone()),
        ("book_id", book.id.clone()), ("book_fingerprint", book.fingerprint.clone()),
        ("book_title", book.title.clone()), ("book_author", book.author.clone()),
        ("chapter", chapter.clone()), ("chapter_href", note.href.clone()), ("cfi", note.cfi.clone()),
        ("session_id", note.session_id.clone()), ("created_at", note.created_at.clone()),
        ("updated_at", note.updated_at.clone()), ("reader_url", reader_url(note)),
    ];
    if let Some(session) = session { fields.push(("reading_started_at", session.started_at.clone())); }
    let yaml: String = fields.iter().map(|(key, val)| format!("{key}: {}\n", value(val))).collect();
    let quote = note.quote.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
        .lines().map(|line| format!("> {line}\n")).collect::<String>();
    format!("---\n{yaml}---\n\n# {} · 阅读笔记\n\n{}\n\n## 原文\n\n{quote}\n## 来源\n\n- 书籍：{}\n- 作者：{}\n- 章节：{}\n- 记录时间：{}\n\n[回到 Reader 原文]({})\n",
        heading(&book.title), note.body, heading(&book.title), heading(&book.author), heading(chapter), note.created_at, reader_url(note))
}

impl Store {
    pub(crate) fn vault_config(&self) -> Result<Option<VaultConfig>> {
        Ok(self.all("SELECT data FROM settings WHERE key='vault'")?.into_iter().next())
    }

    pub fn vault_state(&self) -> Result<VaultState> {
        let config = self.vault_config()?;
        let mut exports = if let Some(config) = &config {
            let mut query = self.db.prepare("SELECT e.data FROM vault_exports e JOIN annotations a ON a.id=e.note_id WHERE e.vault_path=?1 AND a.deleted_at IS NULL UNION ALL SELECT data FROM idea_exports WHERE vault_path=?1").map_err(err)?;
            let rows = query.query_map([&config.path], |row| row.get::<_, String>(0)).map_err(err)?;
            rows.map(|row| serde_json::from_str(&row.map_err(err)?).map_err(err)).collect::<Result<Vec<_>>>()?
        } else { vec![] };
        if let Some(config)=&config {
            let assistant_db=self.data_root().join("assistant.sqlite3");
            if assistant_db.is_file() {
                if let Ok(conn)=rusqlite::Connection::open_with_flags(assistant_db,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) {
                    if let Ok(mut stmt)=conn.prepare("SELECT data FROM conversation_note_exports WHERE vault_path=?1") {
                        if let Ok(rows)=stmt.query_map([&config.path],|r|r.get::<_,String>(0)) {
                            exports.extend(rows.flatten().filter_map(|raw|serde_json::from_str::<ExportRecord>(&raw).ok()));
                        }
                    }
                }
            }
        }
        Ok(VaultState { config, exports })
    }

    pub fn configure_vault(&self, path: Option<String>) -> Result<VaultState> {
        let config = if let Some(path) = path {
            let canonical = fs::canonicalize(path).map_err(|_| "所选目录无法读取。".to_string())?;
            let config = VaultConfig { path: canonical.to_string_lossy().to_string() };
            root(&config)?;
            Some(config)
        } else { None };
        let tx = self.db.unchecked_transaction().map_err(err)?;
        if let Some(config) = &config {
            tx.execute("INSERT INTO settings(key,data) VALUES ('vault',?1) ON CONFLICT(key) DO UPDATE SET data=excluded.data", [json(config)?]).map_err(err)?;
            for note in self.all::<Annotation>("SELECT data FROM annotations WHERE deleted_at IS NULL AND json_extract(data,'$.kind')='note'")? { self.queue_export(&note)?; }
        } else { tx.execute("DELETE FROM settings WHERE key='vault'", []).map_err(err)?; }
        tx.execute("DELETE FROM settings WHERE key='reflect_scope'",[]).map_err(err)?;
        tx.commit().map_err(err)?;
        self.vault_state()
    }

    fn export_record(&self, note_id: &str, config: &VaultConfig) -> Result<Option<ExportRecord>> {
        let raw: Option<String> = self.db.query_row("SELECT data FROM vault_exports WHERE vault_path=?1 AND note_id=?2 UNION ALL SELECT data FROM idea_exports WHERE vault_path=?1 AND note_id=?2", params![config.path, note_id], |row| row.get(0)).optional().map_err(err)?;
        raw.map(|raw| serde_json::from_str(&raw).map_err(err)).transpose()
    }

    fn put_export(&self, record: &ExportRecord) -> Result<()> {
        let is_idea: bool = self.db.query_row("SELECT EXISTS(SELECT 1 FROM ideas WHERE id=?1)",[&record.note_id],|r|r.get(0)).map_err(err)?;
        let table = if is_idea { "idea_exports" } else { "vault_exports" };
        self.db.execute(&format!("INSERT INTO {table}(vault_path,note_id,data) VALUES (?1,?2,?3) ON CONFLICT(vault_path,note_id) DO UPDATE SET data=excluded.data"),
            params![record.vault_path, record.note_id, json(record)?]).map_err(err)?;
        Ok(())
    }

    fn fresh_record(note: &Annotation, config: &VaultConfig) -> Result<ExportRecord> {
        safe_id(&note.id)?;
        let date = DateTime::parse_from_rfc3339(&note.created_at).map_err(err)?.with_timezone(&Local).format("%Y-%m-%d");
        Ok(ExportRecord { note_id: note.id.clone(), vault_path: config.path.clone(),
            relative_path: format!("Reading/{date}--{}.md", note.id), content_hash: None, source_hash: None,
            exported_at: None, status: "pending".into(), message: None, conflict_path: None, backup_path: None })
    }

    pub(crate) fn queue_export(&self, note: &Annotation) -> Result<()> {
        if note.kind != "note" { return Ok(()); }
        let Some(config) = self.vault_config()? else { return Ok(()); };
        let mut record = self.export_record(&note.id, &config)?.unwrap_or(Self::fresh_record(note, &config)?);
        record.status = "pending".into(); record.message = None;
        self.put_export(&record)
    }

    fn preserve_conflict(&self, record: &mut ExportRecord, vault: &Path, bytes: &[u8], message: &str) -> Result<()> {
        let stem = record.relative_path.strip_suffix(".md").ok_or("导出文件名无效。")?;
        let relative = format!("{stem}--reader-{}.md", hash(bytes));
        let path = file_path(vault, &relative, false)?;
        match read_file(&path)? {
            Some(existing) if existing == bytes => {},
            Some(_) => return Err("Reader 副本也已被外部修改；保留双方文件，请另行整理。".into()),
            None => publish_new(&path, bytes)?,
        }
        record.conflict_path = Some(relative);
        record.source_hash = Some(hash(bytes));
        record.status = "conflict".into(); record.message = Some(message.into());
        record.exported_at = Some(Utc::now().to_rfc3339()); record.backup_path = None;
        Ok(())
    }

    fn publish_export(&self, record: &mut ExportRecord, bytes: &[u8]) -> Result<()> {
        self.publish_export_with(record,bytes,|record|self.put_export(record))
    }

    fn publish_export_with(&self, record: &mut ExportRecord, bytes: &[u8], mut journal: impl FnMut(&ExportRecord) -> Result<()>) -> Result<()> {
        let config = VaultConfig { path: record.vault_path.clone() };
        let vault = root(&config)?;
        let path = file_path(&vault, &record.relative_path, false)?;
        let desired_hash = hash(bytes);
        // Recover an interrupted replacement before comparing the original.
        if read_file(&path)?.is_none() {
            if let Some(backup) = &record.backup_path {
                if let Some(original) = read_file(&file_path(&vault, backup, true)?)? {
                    if !original.is_empty() { publish_new(&path, &original)?; }
                }
            }
        }
        match read_file(&path)? {
            Some(current) if hash(&current) == desired_hash => {}, // Includes crash recovery after publication.
            Some(current) if record.content_hash.as_deref() == Some(hash(&current).as_str()) => {
                // Move the previous inode into history, then publish without
                // overwriting a concurrently recreated file. This also preserves
                // late writes from an editor holding the old file open.
                let history = child_dir(&path.parent().ok_or("导出目录无效。")?, ".reader-history")?;
                let temporary = tempfile::Builder::new().prefix(&format!("{}-", record.note_id)).suffix(".md").tempfile_in(&history).map_err(err)?;
                let (_, backup) = temporary.keep().map_err(err)?;
                record.backup_path = Some(format!("Reading/.reader-history/{}", backup.file_name().ok_or("备份文件名无效。")?.to_string_lossy()));
                record.status = "pending".into(); journal(record)?;
                fs::rename(&path, &backup).map_err(err)?;
                let archived = read_file(&backup)?.ok_or("原导出文件未能归档。")?;
                if record.content_hash.as_deref() != Some(hash(&archived).as_str()) {
                    if read_file(&path)?.is_none() { publish_new(&path, &archived)?; }
                    return self.preserve_conflict(record, &vault, bytes, "原文件在导出期间被修改，已保留原文件与 Reader 副本。");
                }
                if let Err(error) = publish_new(&path, bytes) {
                    if read_file(&path)?.is_some() {
                        return self.preserve_conflict(record, &vault, bytes, "原文件在导出期间发生变化，已保留原文件与 Reader 副本。");
                    }
                    let _ = publish_new(&path, &archived);
                    return Err(error);
                }
            },
            Some(_) => return self.preserve_conflict(record, &vault, bytes, "Obsidian 文件已被修改，原文件保留；Reader 内容另存为副本。"),
            None if record.content_hash.is_some() => return self.preserve_conflict(record, &vault, bytes, "原导出文件已移动或移除；Reader 内容已另存为副本。"),
            None => {
                // Journal before touching the Vault; retry can recognize a
                // fully published file even if the following DB update failed.
                record.status = "pending".into(); journal(record)?;
                if let Err(error) = publish_new(&path, bytes) {
                    if read_file(&path)?.is_some() { return self.preserve_conflict(record, &vault, bytes, "同名文件已存在，原文件保留；Reader 内容另存为副本。"); }
                    return Err(error);
                }
            },
        }
        record.status = "synced".into(); record.message = None;
        record.content_hash = Some(desired_hash.clone()); record.source_hash = Some(desired_hash);
        record.exported_at = Some(Utc::now().to_rfc3339()); record.conflict_path = None; record.backup_path = None;
        Ok(())
    }

    pub fn export_note(&self, id: &str) -> Result<ExportRecord> {
        let config = self.vault_config()?.ok_or("请先选择 Obsidian Vault。")?;
        let raw: String = self.db.query_row("SELECT data FROM annotations WHERE id=?1 AND deleted_at IS NULL", [id], |row| row.get(0)).map_err(err)?;
        let note: Annotation = serde_json::from_str(&raw).map_err(err)?;
        if note.kind != "note" { return Err("当前只导出人工笔记，单独的划线保留在 Reader。".into()); }
        let book_raw: String = self.db.query_row("SELECT data FROM books WHERE id=?1", [&note.book_id], |row| row.get(0)).map_err(err)?;
        let book: Book = serde_json::from_str(&book_raw).map_err(err)?;
        let session_raw: Option<String> = self.db.query_row("SELECT data FROM sessions WHERE id=?1", [&note.session_id], |row| row.get(0)).optional().map_err(err)?;
        let session: Option<Session> = session_raw.map(|raw| serde_json::from_str(&raw).map_err(err)).transpose()?;
        let mut record = self.export_record(id, &config)?.unwrap_or(Self::fresh_record(&note, &config)?);
        let bytes = markdown(&note, &book, session.as_ref()).into_bytes();
        if let Err(error) = self.publish_export(&mut record, &bytes) {
            record.status = "failed".into(); record.message = Some(error);
        }
        self.put_export(&record)?;
        Ok(record)
    }

    pub fn export_idea(&self, id: &str) -> Result<ExportRecord> {
        let idea = self.idea(id)?;
        let config = self.vault_config()?.ok_or("请先选择 Obsidian Vault。")?;
        safe_id(&idea.id)?;
        let date = DateTime::parse_from_rfc3339(&idea.created_at).map_err(err)?.with_timezone(&Local).format("%Y-%m-%d");
        let mut record = self.export_record(id,&config)?.unwrap_or(ExportRecord {note_id:idea.id.clone(),vault_path:config.path.clone(),relative_path:format!("Reading/{date}--idea-{}.md",idea.id),content_hash:None,source_hash:None,exported_at:None,status:"pending".into(),message:None,conflict_path:None,backup_path:None});
        let mut text = format!("---\ncreated_by: agent\nconfirmed_by: human\nsource: reader_reflect\nidea_id: {}\ncreated_at: {}\nconfirmed_at: {}\nsource_refs: {}\n---\n\n# {}\n\n{}\n\n## 引用来源\n",value(&idea.id),value(&idea.created_at),value(&idea.confirmed_at),serde_json::to_string(&idea.sources).map_err(err)?,heading(&idea.title),idea.body);
        for citation in &idea.sources {
            let source = &citation.source;
            let link = if let Some(location) = &source.location { Some(location_url(&location.book_id,&location.fingerprint,&location.cfi,&location.href,None)) }
                else if let (Some(root),Some(relative)) = (&source.vault_path,&source.relative_path) {Some(obsidian_url(&Path::new(root).join(relative)))}
                else {None};
            if let Some(link) = link { text.push_str(&format!("\n- [{}]({link}) · `{}`\n",heading(&source.title),source.content_hash)); }
            else {text.push_str(&format!("\n- {} · 已保存的讨论来源 · `{}`\n",heading(&source.title),source.content_hash));}
            let quote = citation.quote.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
            for line in quote.lines() { text.push_str(&format!("> {line}\n")); }
            if let (Some(start),Some(end)) = (source.start_line,source.end_line) { text.push_str(&format!("\n  原文件第 {start}–{end} 行（确认时的版本）。\n")); }
        }
        if let Err(error) = self.publish_export(&mut record,text.as_bytes()) { record.status="failed".into(); record.message=Some(error); }
        self.put_export(&record)?; Ok(record)
    }

    pub fn export_conversation_note(&self, note: &crate::assistant::ConversationNote, assistant: &crate::assistant::AssistantService) -> Result<ExportRecord> {
        let config = self.vault_config()?.ok_or("请先选择 Obsidian Vault。")?;
        safe_id(&note.id)?;
        let date = DateTime::parse_from_rfc3339(&note.created_at).map_err(err)?.with_timezone(&Local).format("%Y-%m-%d");
        let mut record = assistant.get_conversation_export(&config.path, &note.id)?.unwrap_or(ExportRecord {
            note_id: note.id.clone(),
            vault_path: config.path.clone(),
            relative_path: format!("Reading/{date}--note-{}.md", note.id),
            content_hash: None,
            source_hash: None,
            exported_at: None,
            status: "pending".into(),
            message: None,
            conflict_path: None,
            backup_path: None,
        });
        let quote = note.quote.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
            .lines().map(|line| format!("> {line}\n")).collect::<String>();
        let text = format!(
            "---\ncreated_by: human\nsource: reader_conversation\nnote_id: {}\nconversation_id: {}\ncreated_at: {}\n---\n\n# 对话笔记\n\n{}\n\n## 原文摘录\n\n{}\n",
            value(&note.id), value(&note.conversation_id), value(&note.created_at), note.body, quote
        );
        if let Err(error) = self.publish_export_with(&mut record, text.as_bytes(),|record|assistant.put_conversation_export(record)) {
            record.status = "failed".into();
            record.message = Some(error);
        }
        assistant.put_conversation_export(&record)?;
        Ok(record)
    }

    pub fn exported_path(&self, id: &str, copy: bool) -> Result<PathBuf> {
        let config = self.vault_config()?.ok_or("请先选择 Obsidian Vault。")?;
        let record = self.export_record(id, &config)?.ok_or("这条笔记还未导出。")?;
        let relative = if copy { record.conflict_path.as_deref().ok_or("这条笔记没有 Reader 副本。")? } else { &record.relative_path };
        let path = file_path(&root(&config)?, relative, false)?;
        read_file(&path)?.ok_or("导出文件暂时不可用。请检查 Vault 后重试。")?;
        Ok(path)
    }
}

pub fn obsidian_url(path: &Path) -> String { format!("obsidian://open?path={}", encoded(&path.to_string_lossy())) }
