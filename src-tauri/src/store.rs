use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::{Path, PathBuf}};

type Result<T> = std::result::Result<T, String>;
const MAX_EPUB_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub id: String,
    pub fingerprint: String,
    pub title: String,
    pub author: String,
    pub language: String,
    pub cover: Option<String>,
    pub imported_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub book_id: String,
    pub cfi: String,
    pub href: String,
    pub chapter_label: String,
    pub percent: Option<f64>,
    pub updated_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: String,
    pub book_id: String,
    pub fingerprint: String,
    pub cfi: String,
    pub href: String,
    pub quote: String,
    pub kind: String,
    pub body: String,
    pub session_id: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub chapter_label: String,
    #[serde(default = "human")]
    pub created_by: String,
}
fn human() -> String { "human".into() }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub book_id: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub active_seconds: f64,
    pub updated_at: String,
    pub start_cfi: String,
    pub end_cfi: String,
    #[serde(default)]
    pub start_position: Option<Position>,
    #[serde(default)]
    pub end_position: Option<Position>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub font_size: u32,
    pub line_height: f64,
    pub theme: String,
    #[serde(default = "default_columns")]
    pub columns: String,
    pub last_book_id: Option<String>,
}
fn default_columns() -> String { "single".into() }
impl Default for Settings {
    fn default() -> Self { Self { font_size: 19, line_height: 1.8, theme: "light".into(), columns: default_columns(), last_book_id: None } }
}

#[derive(Serialize)]
pub struct Snapshot {
    pub books: Vec<Book>,
    pub positions: Vec<Position>,
    pub annotations: Vec<Annotation>,
    pub sessions: Vec<Session>,
    pub settings: Settings,
    pub vault: Option<crate::vault::VaultConfig>,
    pub exports: Vec<crate::vault::ExportRecord>,
}

pub struct Store { pub(crate) db: Connection, books_dir: PathBuf }

fn err(e: impl std::fmt::Display) -> String { format!("本地数据操作失败：{e}") }
fn json<T: Serialize>(v: &T) -> Result<String> { serde_json::to_string(v).map_err(err) }
fn valid_id(id: &str) -> Result<()> {
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err("书籍标识无效。".into());
    }
    Ok(())
}
fn valid_cfi(cfi: &str) -> Result<()> {
    if !cfi.starts_with("epubcfi(") || !cfi.ends_with(')') { return Err("阅读位置无效。".into()); }
    Ok(())
}

pub fn read_epub(path: &Path) -> Result<Vec<u8>> {
    if !path.extension().is_some_and(|x| x.to_string_lossy().eq_ignore_ascii_case("epub")) {
        return Err("请选择 EPUB 文件。".into());
    }
    let size = fs::metadata(path).map_err(|_| "书籍文件无法读取。请重新选择原始 EPUB。".to_string())?.len();
    if size > MAX_EPUB_BYTES { return Err("第一版暂不支持超过 100 MB 的 EPUB。".into()); }
    let bytes = fs::read(path).map_err(err)?;
    if !bytes.starts_with(b"PK\x03\x04") { return Err("文件不是有效的 EPUB 压缩包。".into()); }
    Ok(bytes)
}

impl Store {
    pub(crate) fn data_root(&self) -> &Path { self.books_dir.parent().expect("books root") }
    /// Query-only access: no directories, migrations, WAL changes or session completion.
    pub fn open_readonly(root: &Path) -> Result<Option<Self>> {
        let path = root.join("reader.sqlite3");
        match fs::metadata(&path) {
            Ok(value) if value.is_file() => (),
            Ok(_) => return Err("Reader 数据库路径不是普通文件。".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(err(error)),
        }
        let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(err)?;
        db.busy_timeout(std::time::Duration::from_secs(3)).map_err(err)?;
        db.execute_batch("PRAGMA query_only=ON;").map_err(err)?;
        let version: u32 = db.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(err)?;
        if version != 2 && version != 3 { return Err("Reader 数据版本不兼容，请先用应用打开。".into()); }
        Ok(Some(Self { db, books_dir: root.join("books") }))
    }
    pub fn open(root: &Path) -> Result<Self> {
        let books_dir = root.join("books");
        fs::create_dir_all(&books_dir).map_err(err)?;
        let mut db = Connection::open(root.join("reader.sqlite3")).map_err(err)?;
        db.busy_timeout(std::time::Duration::from_secs(5)).map_err(err)?;
        db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;").map_err(err)?;
        let version: u32 = db.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(err)?;
        if version > 3 { return Err("数据库版本高于当前应用版本。请使用更新的 Reader 打开。".into()); }
        if version == 0 {
            let tx = db.transaction().map_err(err)?;
            tx.execute_batch("
                CREATE TABLE books (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
                CREATE TABLE positions (book_id TEXT PRIMARY KEY REFERENCES books(id), data TEXT NOT NULL);
                CREATE TABLE annotations (id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id), data TEXT NOT NULL, deleted_at TEXT);
                CREATE INDEX annotation_book ON annotations(book_id);
                CREATE TABLE sessions (id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id), data TEXT NOT NULL);
                CREATE TABLE settings (key TEXT PRIMARY KEY, data TEXT NOT NULL);
                PRAGMA user_version=1;
            ").map_err(err)?;
            tx.commit().map_err(err)?;
        }
        if version < 2 {
            let tx = db.transaction().map_err(err)?;
            tx.execute_batch("CREATE TABLE vault_exports (
                vault_path TEXT NOT NULL, note_id TEXT NOT NULL REFERENCES annotations(id),
                data TEXT NOT NULL, PRIMARY KEY(vault_path,note_id));
                PRAGMA user_version=2;").map_err(err)?;
            tx.commit().map_err(err)?;
        }
        if version < 3 {
            let tx = db.transaction().map_err(err)?;
            tx.execute_batch("CREATE TABLE ideas (id TEXT PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE idea_exports (vault_path TEXT NOT NULL, note_id TEXT NOT NULL REFERENCES ideas(id), data TEXT NOT NULL, PRIMARY KEY(vault_path,note_id));
                PRAGMA user_version=3;").map_err(err)?;
            tx.commit().map_err(err)?;
        }
        // Finish abandoned sessions at their last durable heartbeat, not at today's launch.
        db.execute("UPDATE sessions SET data=json_set(data,'$.endedAt',json_extract(data,'$.updatedAt')) WHERE json_extract(data,'$.endedAt') IS NULL", []).map_err(err)?;
        Ok(Self { db, books_dir })
    }

    pub(crate) fn all<T: for<'de> Deserialize<'de>>(&self, sql: &str) -> Result<Vec<T>> {
        let mut stmt = self.db.prepare(sql).map_err(err)?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
        rows.map(|row| serde_json::from_str(&row.map_err(err)?).map_err(err)).collect()
    }

    pub fn snapshot(&self) -> Result<Snapshot> {
        let vault = self.vault_state()?;
        Ok(Snapshot {
            books: self.all("SELECT data FROM books ORDER BY json_extract(data,'$.importedAt') DESC")?,
            positions: self.all("SELECT data FROM positions")?,
            annotations: self.all("SELECT data FROM annotations WHERE deleted_at IS NULL ORDER BY json_extract(data,'$.createdAt')")?,
            sessions: self.all("SELECT data FROM sessions ORDER BY json_extract(data,'$.startedAt')")?,
            settings: self.all("SELECT data FROM settings WHERE key='reader'")?.into_iter().next().unwrap_or_default(),
            vault: vault.config,
            exports: vault.exports,
        })
    }

    pub fn import(&mut self, book: &Book, source: &Path) -> Result<()> {
        let bytes = read_epub(source)?;
        self.import_bytes(book, &bytes)
    }

    pub fn import_bytes(&mut self, book: &Book, bytes: &[u8]) -> Result<()> {
        valid_id(&book.id)?;
        let hash = format!("{:x}", Sha256::digest(bytes));
        if hash != book.id || hash != book.fingerprint { return Err("文件在导入过程中发生变化，请重新导入。".into()); }
        let destination = self.books_dir.join(format!("{hash}.epub"));
        if !destination.exists() {
            let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&destination).map_err(err)?;
            file.write_all(&bytes).map_err(err)?;
            file.sync_all().map_err(err)?;
        } else {
            let existing = fs::read(&destination).map_err(err)?;
            if format!("{:x}", Sha256::digest(existing)) != hash { return Err("已保存的书籍副本校验失败。原始文件保留不变，请先备份应用数据。".into()); }
        }
        let tx = self.db.transaction().map_err(err)?;
        tx.execute("INSERT INTO books(id,fingerprint,data) VALUES (?1,?2,?3) ON CONFLICT(id) DO NOTHING", params![book.id, hash, json(book)?]).map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(())
    }

    pub fn load(&self, id: &str) -> Result<Vec<u8>> {
        valid_id(id)?;
        let bytes = read_epub(&self.books_dir.join(format!("{id}.epub")))?;
        if format!("{:x}", Sha256::digest(&bytes)) != id { return Err("书籍副本校验失败，请恢复原始 EPUB。".into()); }
        Ok(bytes)
    }

    pub fn save_position(&self, p: &Position) -> Result<()> {
        valid_cfi(&p.cfi)?;
        if p.percent.is_some_and(|v| !v.is_finite() || !(0.0..=1.0).contains(&v)) { return Err("进度无效。".into()); }
        self.db.execute("INSERT INTO positions(book_id,data) VALUES (?1,?2) ON CONFLICT(book_id) DO UPDATE SET data=excluded.data", params![p.book_id, json(p)?]).map_err(err)?;
        Ok(())
    }

    pub fn save_annotation(&self, a: &Annotation) -> Result<()> {
        valid_cfi(&a.cfi)?;
        if a.quote.trim().is_empty() || a.quote.len() > 100_000 || a.body.len() > 100_000 || a.id.is_empty() { return Err("划线或笔记内容无效。".into()); }
        if a.kind != "highlight" && a.kind != "note" { return Err("标注类型无效。".into()); }
        if a.kind == "note" && a.body.trim().is_empty() { return Err("请先写下笔记。".into()); }
        let fingerprint: String = self.db.query_row("SELECT fingerprint FROM books WHERE id=?1", [&a.book_id], |r| r.get(0)).map_err(err)?;
        if fingerprint != a.fingerprint { return Err("笔记与书籍版本不一致。".into()); }
        if a.created_by != "human" { return Err("当前版本只保存人工阅读笔记。".into()); }
        let tx = self.db.unchecked_transaction().map_err(err)?;
        tx.execute("INSERT INTO annotations(id,book_id,data) VALUES (?1,?2,?3) ON CONFLICT(id) DO UPDATE SET data=excluded.data,deleted_at=NULL WHERE annotations.book_id=excluded.book_id", params![a.id, a.book_id, json(a)?]).map_err(err)?;
        self.queue_export(a)?;
        tx.commit().map_err(err)?;
        Ok(())
    }

    pub fn delete_annotation(&self, id: &str) -> Result<()> {
        self.db.execute("UPDATE annotations SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1", [id]).map_err(err)?;
        Ok(())
    }

    pub fn save_session(&self, s: &Session) -> Result<()> {
        if !s.active_seconds.is_finite() || s.active_seconds < 0.0 { return Err("阅读时长无效。".into()); }
        for (position, cfi) in [(&s.start_position, &s.start_cfi), (&s.end_position, &s.end_cfi)] {
            if let Some(position) = position {
                valid_cfi(&position.cfi)?;
                if position.book_id != s.book_id || position.cfi != *cfi || position.href.is_empty()
                    || position.percent.is_some_and(|v| !v.is_finite() || !(0.0..=1.0).contains(&v)) {
                    return Err("阅读会话的来源位置不一致。".into());
                }
            }
        }
        self.db.execute("INSERT INTO sessions(id,book_id,data) VALUES (?1,?2,?3) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE sessions.book_id=excluded.book_id", params![s.id, s.book_id, json(s)?]).map_err(err)?;
        Ok(())
    }

    pub fn save_settings(&self, s: &Settings) -> Result<()> {
        if !(16..=28).contains(&s.font_size) || !s.line_height.is_finite() || !(1.4..=2.2).contains(&s.line_height) || (s.theme != "light" && s.theme != "dark") || !matches!(s.columns.as_str(), "single" | "double") { return Err("阅读设置无效。".into()); }
        self.db.execute("INSERT INTO settings(key,data) VALUES ('reader',?1) ON CONFLICT(key) DO UPDATE SET data=excluded.data", [json(s)?]).map_err(err)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Book, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.epub");
        let bytes = b"PK\x03\x04reader test bytes";
        fs::write(&source, bytes).unwrap();
        let id = format!("{:x}", Sha256::digest(bytes));
        let book = Book { id: id.clone(), fingerprint: id, title:"Test".into(), author:"Reader".into(), language:"en".into(), cover:None, imported_at:"2026-10-02T00:00:00Z".into() };
        (dir, book, source)
    }
    #[test]
    fn restart_restores_position_note_and_original_file() {
        let (dir, book, source) = fixture();
        let root = dir.path().join("data");
        {
            let mut store = Store::open(&root).unwrap();
            store.import(&book, &source).unwrap();
            store.import(&book, &source).unwrap();
            store.save_position(&Position { book_id:book.id.clone(), cfi:"epubcfi(/6/2!/4/2/1:0)".into(), href:"chapter.xhtml".into(), chapter_label:"Chapter".into(), percent:Some(0.25), updated_at:"now".into() }).unwrap();
            store.save_annotation(&Annotation { id:"note-1".into(),book_id:book.id.clone(),fingerprint:book.fingerprint.clone(),cfi:"epubcfi(/6/2!/4/2/1:0)".into(),href:"chapter.xhtml".into(),quote:"original".into(),kind:"note".into(),body:"my thought".into(),session_id:"session".into(),created_at:"now".into(),updated_at:"now".into(),chapter_label:String::new(),created_by:human() }).unwrap();
        }
        let store = Store::open(&root).unwrap();
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.books.len(), 1);
        assert_eq!(snapshot.positions[0].percent, Some(0.25));
        assert_eq!(snapshot.annotations[0].body, "my thought");
        assert_eq!(store.load(&book.id).unwrap(), fs::read(source).unwrap());
    }
    #[test]
    fn invalid_data_and_foreign_version_do_not_overwrite_notes() {
        let (dir, book, source) = fixture();
        let mut store = Store::open(&dir.path().join("data")).unwrap();
        store.import(&book, &source).unwrap();
        let mut note = Annotation { id:"a".into(),book_id:book.id.clone(),fingerprint:book.id.clone(),cfi:"epubcfi(/6/2!/4/2/1:0)".into(),href:"chapter.xhtml".into(),quote:"text".into(),kind:"note".into(),body:"saved".into(),session_id:"s".into(),created_at:"now".into(),updated_at:"now".into(),chapter_label:String::new(),created_by:human() };
        store.save_annotation(&note).unwrap();
        note.body.clear();
        assert!(store.save_annotation(&note).is_err());
        assert_eq!(store.snapshot().unwrap().annotations[0].body, "saved");
        store.delete_annotation("a").unwrap();
        assert!(store.snapshot().unwrap().annotations.is_empty());
        let count: u32 = store.db.query_row("SELECT COUNT(*) FROM annotations", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1); // Soft deletion preserves content.
        assert!(store.load("../source").is_err());
        let newer = dir.path().join("newer");
        fs::create_dir_all(&newer).unwrap();
        Connection::open(newer.join("reader.sqlite3")).unwrap().execute_batch("PRAGMA user_version=3").unwrap();
        assert!(Store::open(&newer).is_err());
    }
    #[test]
    fn abandoned_session_ends_at_last_saved_heartbeat() {
        let (dir, book, source) = fixture();
        let root = dir.path().join("data");
        {
            let mut store = Store::open(&root).unwrap();
            store.import(&book,&source).unwrap();
            store.save_session(&Session { id:"s".into(),book_id:book.id,started_at:"2026-10-02T00:00:00Z".into(),ended_at:None,active_seconds:25.0,updated_at:"2026-10-02T00:00:25Z".into(),start_cfi:"".into(),end_cfi:"".into(),start_position:None,end_position:None }).unwrap();
        }
        let snapshot = Store::open(&root).unwrap().snapshot().unwrap();
        assert_eq!(snapshot.sessions[0].ended_at.as_deref(),Some("2026-10-02T00:00:25Z"));
        assert_eq!(snapshot.sessions[0].active_seconds,25.0);
    }
}
