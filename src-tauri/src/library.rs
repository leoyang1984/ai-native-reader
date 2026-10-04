//! Unified local library retrieval for human notes, confirmed ideas, and Obsidian Vault Markdown documents.
use crate::assistant::{Anchor, Source};
use crate::store::{Annotation, Book, Store};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySearchResult {
    pub sources: Vec<Source>,
    pub coverage_scope: String,
    pub matched_count: usize,
    #[serde(default)] pub partial: bool,
}

#[derive(Clone, Debug)]
pub struct ResolvedVaultScope {
    pub vault_path: PathBuf,
    pub search_dir: PathBuf,
    pub is_custom: bool,
}

/// Automatically inherit Vault configuration from Store without re-prompting the user.
pub fn resolve_vault_scope(store: &Store) -> Option<ResolvedVaultScope> {
    // 1. If custom reflect_scope exists and valid, use it
    if let Ok(Some(scope)) = store.reflect_scope() {
        if let Ok(vault_root) = fs::canonicalize(&scope.vault_path) {
            if vault_root.is_dir() && vault_root.join(".obsidian").is_dir() {
                if let Ok(search_dir) = fs::canonicalize(&scope.path) {
                    if search_dir.is_dir() && search_dir.starts_with(&vault_root) {
                        return Some(ResolvedVaultScope {
                            vault_path: vault_root,
                            search_dir,
                            is_custom: true,
                        });
                    }
                }
            }
        }
        return None;
    }

    // 2. Otherwise auto-inherit the connected vault_config as default search boundary
    if let Ok(Some(vault_cfg)) = store.vault_config() {
        if let Ok(vault_root) = fs::canonicalize(&vault_cfg.path) {
            if vault_root.is_dir() && vault_root.join(".obsidian").is_dir() {
                return Some(ResolvedVaultScope {
                    search_dir: vault_root.clone(),
                    vault_path: vault_root,
                    is_custom: false,
                });
            }
        }
    }

    None
}

/// Standalone derived SQLite index for Obsidian Vault Markdown documents.
pub struct VaultIndex {
    db: rusqlite::Connection,
    has_fts5: bool,
}

pub struct VaultSyncReport {
    pub total_indexed: usize,
    pub skipped_oversize: usize,
    pub complete: bool,
}

impl VaultIndex {
    pub fn open(db_path: &Path) -> rusqlite::Result<Self> {
        let db = rusqlite::Connection::open(db_path)?;
        db.busy_timeout(std::time::Duration::from_secs(3))?;
        db.execute_batch("
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=NORMAL;
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, val TEXT);
            CREATE TABLE IF NOT EXISTS docs (
                relative_path TEXT PRIMARY KEY,
                mtime INTEGER NOT NULL,
                size INTEGER NOT NULL,
                content_hash TEXT NOT NULL,
                content TEXT NOT NULL
            );
        ")?;
        let has_fts5 = db.execute_batch("
            CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
                relative_path UNINDEXED,
                content,
                tokenize='trigram'
            );
        ").is_ok();
        Ok(Self { db, has_fts5 })
    }

    pub fn clear(&mut self) -> rusqlite::Result<()> {
        let tx=self.db.transaction()?;
        tx.execute("DELETE FROM docs",[])?;
        tx.execute("DELETE FROM meta",[])?;
        if self.has_fts5 {tx.execute("DELETE FROM docs_fts",[])?;}
        tx.commit()
    }

    /// Incremental scan of Vault directory: skips unmutated files, cleans deletions, removes old index on vault change.
    pub fn sync_vault(&mut self, scope: &ResolvedVaultScope) -> rusqlite::Result<VaultSyncReport> {
        let current_vault = format!("{}|{}",scope.vault_path.display(),scope.search_dir.display());
        let saved_vault: Option<String> = self.db.query_row(
            "SELECT val FROM meta WHERE key='vault_path'",
            [],
            |r| r.get(0),
        ).optional()?;

        // If vault path changed, clear old index immediately
        if saved_vault.as_deref() != Some(&current_vault) {
            let tx = self.db.transaction()?;
            tx.execute("DELETE FROM docs", [])?;
            if self.has_fts5 {
                let _ = tx.execute("DELETE FROM docs_fts", []);
            }
            tx.execute(
                "INSERT INTO meta(key, val) VALUES ('vault_path', ?1) ON CONFLICT(key) DO UPDATE SET val=excluded.val",
                [&current_vault],
            )?;
            tx.commit()?;
        }

        let mut seen_paths = HashSet::new();
        let mut stack = vec![(scope.search_dir.clone(), 0usize)];
        let mut skipped_oversize = 0;
        let mut file_count = 0;
        let mut complete = true;
        let max_files = 512;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);

        'walk: while let Some((dir, depth)) = stack.pop() {
            if depth > 6 || std::time::Instant::now() > deadline {
                complete = false; break;
            }
            let Ok(entries) = fs::read_dir(&dir) else { complete = false; continue; };
            for entry in entries.flatten() {
                if file_count >= max_files || std::time::Instant::now() > deadline {
                    complete = false; break 'walk;
                }
                let path = entry.path();
                let file_name = entry.file_name();
                let name = file_name.to_string_lossy();
                // Exclude hidden files or directories (.obsidian, .trash, etc.)
                if name.starts_with('.') {
                    continue;
                }
                let Ok(meta) = fs::symlink_metadata(&path) else { continue; };
                // Exclude symlinks
                if meta.file_type().is_symlink() {
                    continue;
                }
                if meta.is_dir() {
                    if depth < 6 { stack.push((path, depth + 1)); } else { complete = false; }
                    continue;
                }
                if !meta.is_file() || !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("md")) {
                    continue;
                }

                let Ok(rel) = path.strip_prefix(&scope.vault_path) else { continue; };
                let rel_str = rel.to_string_lossy().to_string();
                if rel_str.is_empty() || rel_str.contains('\0') || rel_str.starts_with('.') {
                    continue;
                }

                // File size ceiling: 128 KiB
                if meta.len() > 128 * 1024 {
                    skipped_oversize += 1;
                    continue;
                }

                file_count += 1;
                seen_paths.insert(rel_str.clone());

                let mtime = meta.modified().ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_nanos().min(i64::MAX as u128) as i64)
                    .unwrap_or(0);
                let size = meta.len() as i64;

                let existing: Option<(i64, i64)> = self.db.query_row(
                    "SELECT mtime, size FROM docs WHERE relative_path=?1",
                    [&rel_str],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                ).optional()?;

                if let Some((old_mtime, old_size)) = existing {
                    if old_mtime == mtime && old_size == size {
                        continue; // File unmutated, skip reading
                    }
                }

                let Ok((content,content_hash)) = crate::reflect::read_markdown(&path) else { complete = false; continue; };

                let tx = self.db.transaction()?;
                tx.execute(
                    "INSERT INTO docs(relative_path, mtime, size, content_hash, content) VALUES (?1, ?2, ?3, ?4, ?5) \
                     ON CONFLICT(relative_path) DO UPDATE SET mtime=excluded.mtime, size=excluded.size, content_hash=excluded.content_hash, content=excluded.content",
                    rusqlite::params![rel_str, mtime, size, content_hash, content],
                )?;
                if self.has_fts5 {
                    let _ = tx.execute("DELETE FROM docs_fts WHERE relative_path=?1", [&rel_str]);
                    let _ = tx.execute("INSERT INTO docs_fts(relative_path, content) VALUES (?1, ?2)", rusqlite::params![rel_str, content]);
                }
                tx.commit()?;
            }
        }

        // Clean up deletions if complete scan finished within boundaries
        if complete {
            let mut stmt = self.db.prepare("SELECT relative_path FROM docs")?;
            let stored_paths = stmt.query_map([], |r| r.get::<_, String>(0))?
                .filter_map(|r| r.ok())
                .collect::<Vec<_>>();
            drop(stmt);
            for p in stored_paths {
                if !seen_paths.contains(&p) {
                    let tx = self.db.transaction()?;
                    tx.execute("DELETE FROM docs WHERE relative_path=?1", [&p])?;
                    if self.has_fts5 {
                        let _ = tx.execute("DELETE FROM docs_fts WHERE relative_path=?1", [&p]);
                    }
                    tx.commit()?;
                }
            }
        }

        Ok(VaultSyncReport {
            total_indexed: file_count,
            skipped_oversize, complete,
        })
    }

    /// Search candidate Vault documents, verifying live disk version prior to returning.
    pub fn search(
        &self,
        keywords: &[String],
        scope: &ResolvedVaultScope,
        max_results: usize,
    ) -> Vec<(String, String, String)> {
        let mut candidates = Vec::new();
        let mut seen = HashSet::new();

        for kw in keywords {
            if candidates.len() >= max_results {
                break;
            }
            let pattern = kw.trim();
            if pattern.is_empty() {
                continue;
            }

            // Parameterized literal instr fallback covers any keyword length (1, 2, 3+ chars)
            let mut stmt = match self.db.prepare(
                "SELECT relative_path, content, content_hash FROM docs \
                 WHERE instr(lower(content), lower(?1)) > 0 \
                 ORDER BY relative_path LIMIT 32"
            ) {
                Ok(s) => s,
                Err(_) => continue,
            };

            let rows = match stmt.query_map([pattern], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
            }) {
                Ok(r) => r,
                Err(_) => continue,
            };

            for row in rows.flatten() {
                if candidates.len() >= max_results {
                    break;
                }
                let (rel_path, _indexed_content, _hash) = row;
                if !seen.insert(rel_path.clone()) {
                    continue;
                }

                // Verify with current real file on disk to prevent using obsolete index
                let Ok(real_path) = crate::reflect::safe_path(&scope.vault_path, &rel_path) else { continue; };
                if !real_path.starts_with(&scope.search_dir) { continue; }
                let Ok(live_meta) = fs::symlink_metadata(&real_path) else { continue; };
                if !live_meta.is_file() || live_meta.file_type().is_symlink() || live_meta.len() > 128 * 1024 {
                    continue;
                }
                let Ok((live_content,live_hash)) = crate::reflect::read_markdown(&real_path) else { continue; };
                if !live_content.to_lowercase().contains(&pattern.to_lowercase()) {
                    continue;
                }

                let (excerpt_text, _) = excerpt(&live_content, pattern);
                candidates.push((rel_path, excerpt_text, live_hash));
            }
        }

        candidates
    }
}

/// Extract up to 3 bounded, meaningful search keywords from natural language input.
pub fn extract_keywords(query: &str) -> Vec<String> {
    let text = query.trim();
    if text.is_empty() {
        return Vec::new();
    }
    let mut keywords = Vec::new();

    // 1. Prioritize explicit quotes in Chinese or Western punctuation: 「...」, “...”, "..."
    let quote_pairs = [('「', '」'), ('“', '”'), ('"', '"'), ('\'', '\'')];
    for (open, close) in quote_pairs {
        let mut rest = text;
        while let Some(start) = rest.find(open) {
            let after = &rest[start + open.len_utf8()..];
            if let Some(end) = after.find(close) {
                let quoted = after[..end].trim();
                if quoted.chars().count() >= 1 && quoted.chars().count() <= 40 {
                    if !keywords.iter().any(|k: &String| k.eq_ignore_ascii_case(quoted)) {
                        keywords.push(quoted.to_string());
                    }
                }
                rest = &after[end + close.len_utf8()..];
            } else {
                break;
            }
        }
    }

    if !keywords.is_empty() {
        return keywords.into_iter().take(3).collect();
    }

    // 2. Strip conversational interrogatives and stop phrases
    let stops = [
        "请问", "是什么", "什么是", "为什么", "怎么看", "如何理解", "怎么样",
        "有没有", "是否", "聊聊", "说说", "讨论过", "记过", "我之前", "我们之前", "我们在之前",
        "我的笔记", "在笔记里", "相关笔记", "已确认想法", "想法里", "总结一下", "分析一下",
        "有哪些", "关于", "对于", "因为", "所以", "如果",
        "之间的关系", "的关系", "与", "和", "以及", "或者", "的",
        "what is", "how to", "tell me about", "in my notes", "do you think",
    ];

    let mut cleaned = text.to_lowercase();
    for stop in stops {
        cleaned = cleaned.replace(stop, " ");
    }

    // 3. Extract English words (length >= 3)
    let eng_words: Vec<&str> = cleaned
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|w| w.is_ascii() && w.chars().count() >= 3 && !is_english_stop_word(w))
        .collect();

    for w in eng_words {
        if keywords.len() >= 3 {
            break;
        }
        if !keywords.iter().any(|k: &String| k.eq_ignore_ascii_case(w)) {
            keywords.push(w.to_string());
        }
    }

    if keywords.len() >= 3 {
        return keywords.into_iter().take(3).collect();
    }

    // 4. Extract Chinese segments (non-ascii continuous tokens, length >= 2)
    let cjk_segments: Vec<&str> = cleaned
        .split(|c: char| c.is_ascii() || c.is_whitespace() || is_punctuation(c))
        .filter(|s| s.chars().count() >= 2)
        .collect();

    for seg in cjk_segments {
        if keywords.len() >= 3 {
            break;
        }
        let chunk: String = seg.chars().take(12).collect();
        if chunk.chars().count() >= 2 && !keywords.iter().any(|k: &String| k == &chunk) {
            keywords.push(chunk);
        }
    }

    // 5. Fallback: if no keywords extracted, use clipped natural input if short enough
    if keywords.is_empty() {
        let trimmed: String = text
            .chars()
            .filter(|c| !is_punctuation(*c) && !c.is_whitespace())
            .take(16)
            .collect();
        if trimmed.chars().count() >= 2 {
            keywords.push(trimmed);
        }
    }

    keywords.into_iter().take(3).collect()
}

fn is_english_stop_word(w: &str) -> bool {
    matches!(
        w,
        "the" | "and" | "for" | "that" | "this" | "with" | "from" | "have" | "not" | "are" | "was"
            | "were" | "been" | "will" | "would" | "could" | "should" | "can" | "all" | "any"
            | "some" | "one" | "about" | "into" | "more" | "than" | "when" | "where" | "which"
    )
}

fn is_punctuation(c: char) -> bool {
    matches!(
        c,
        '?' | '!' | '，' | '。' | '；' | '：' | '？' | '！' | '、' | '（' | '）' | '(' | ')' | '[' | ']'
            | '{' | '}' | '<' | '>' | '《' | '》' | '"' | '\'' | '“' | '”' | '‘' | '’' | '—' | '-' | '…'
    )
}

fn clip(text: &str, count: usize) -> String {
    text.chars().take(count).collect()
}

fn excerpt(text: &str, query: &str) -> (String, bool) {
    let lower_text = text.to_ascii_lowercase();
    let lower_query = query.to_ascii_lowercase();
    let at = if query.is_empty() { 0 } else { lower_text.find(&lower_query).unwrap_or(0) };
    let start_chars = text[..at].chars().count().saturating_sub(160);
    let start = text.char_indices().nth(start_chars).map(|v| v.0).unwrap_or(0);
    let result: String = text[start..].chars().take(900).collect();
    let truncated = result.chars().count() < text.chars().count();
    (result, truncated)
}

/// Bounded unified retrieval across Reader human notes, confirmed ideas, and Obsidian Vault Markdown documents.
pub fn search_local_library(
    store: &Store,
    query: &str,
    current_book_id: Option<&str>,
    index_db_path: Option<&Path>,
) -> LibrarySearchResult {
    let keywords = extract_keywords(query);
    let vault_scope = resolve_vault_scope(store);

    let mut scope_description = match &vault_scope {
        Some(s) => format!("已检索本地人工笔记、已确认想法与 Obsidian Vault（{}）", s.search_dir.display()),
        None => "已检索本地人工笔记与已确认想法（Vault 未连接或不可用）".to_string(),
    };

    if keywords.is_empty() {
        return LibrarySearchResult {
            sources: Vec::new(),
            coverage_scope: scope_description,
            matched_count: 0, partial: false,
        };
    }

    if vault_scope.is_none() {
        if let Some(path)=index_db_path {
            if path.exists() {if let Ok(mut index)=VaultIndex::open(path) {let _=index.clear();}}
        }
    }
    let mut partial = false;
    let mut sources = Vec::new();
    let mut seen_ids = HashSet::new();
    let mut note_hashes = HashSet::new();

    // Query exported records for deduplication between notes and markdown copies
    if let Ok(mut stmt) = store.db.prepare("SELECT note_id, json_extract(data, '$.relativePath'), json_extract(data, '$.contentHash') FROM vault_exports WHERE vault_path=?1 UNION ALL SELECT note_id, json_extract(data, '$.relativePath'), json_extract(data, '$.contentHash') FROM idea_exports WHERE vault_path=?1") {
        if let Ok(rows) = stmt.query_map([vault_scope.as_ref().map(|s|s.vault_path.to_string_lossy().to_string()).unwrap_or_default()], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?))) {
            for row in rows.flatten() {
                if let Some(h) = row.2 {
                    note_hashes.insert(h);
                }
            }
        }
    }

    // 1. Search Human Annotations (notes with createdBy='human')
    for kw in &keywords {
        if sources.len() >= 3 {
            break;
        }
        let pattern = kw.trim();
        if pattern.is_empty() {
            continue;
        }

        let sql = "SELECT a.data, b.data FROM annotations a JOIN books b ON b.id=a.book_id \
                   WHERE a.deleted_at IS NULL \
                     AND json_extract(a.data, '$.kind') = 'note' \
                     AND coalesce(json_extract(a.data, '$.createdBy'), 'human') = 'human' \
                     AND (instr(lower(json_extract(a.data, '$.body')), lower(?1)) > 0 \
                          OR instr(lower(json_extract(a.data, '$.quote')), lower(?1)) > 0) \
                   ORDER BY (CASE WHEN ?2 IS NOT NULL AND a.book_id = ?2 THEN 0 ELSE 1 END), \
                            json_extract(a.data, '$.createdAt') DESC \
                   LIMIT 3";

        let mut stmt = match store.db.prepare(sql) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let rows = match stmt.query_map(rusqlite::params![pattern, current_book_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) {
            Ok(r) => r,
            Err(_) => continue,
        };

        for row in rows.flatten() {
            if sources.len() >= 3 {
                break;
            }
            let note: Annotation = match serde_json::from_str(&row.0) {
                Ok(n) => n,
                Err(_) => continue,
            };
            let book: Book = match serde_json::from_str(&row.1) {
                Ok(b) => b,
                Err(_) => continue,
            };

            if !seen_ids.insert(format!("note:{}", note.id)) {
                continue;
            }

            let full_text = if note.quote.trim().is_empty() {
                note.body.clone()
            } else {
                format!("{}\n原文摘录：{}", note.body, note.quote)
            };
            note_hashes.insert(format!("{:x}", Sha256::digest(full_text.as_bytes())));

            let clipped = clip(&full_text, 900);
            let truncated = clipped.len() < full_text.len();
            let anchor = if !note.cfi.is_empty() {
                Some(Anchor {
                    cfi: note.cfi,
                    href: note.href,
                })
            } else {
                None
            };

            let source = Source::note(
                note.id,
                book.id,
                book.title,
                note.chapter_label,
                clipped,
                truncated,
                anchor,
            );
            sources.push(source);
        }
    }

    // 1.5. Search Conversation Notes (if assistant.sqlite3 exists)
    if let Some(assistant_db) = index_db_path.and_then(|p| p.parent()).map(|d| d.join("assistant.sqlite3")).filter(|p| p.exists()) {
        if let Ok(conn) = rusqlite::Connection::open_with_flags(&assistant_db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) {
            if let Some(scope)=&vault_scope {
                if let Ok(mut stmt)=conn.prepare("SELECT data FROM conversation_note_exports WHERE vault_path=?1") {
                    if let Ok(rows)=stmt.query_map([scope.vault_path.to_string_lossy().as_ref()],|r|r.get::<_,String>(0)) {
                        for raw in rows.flatten() {
                            if let Ok(record)=serde_json::from_str::<crate::vault::ExportRecord>(&raw) {
                                if let Some(hash)=record.content_hash {note_hashes.insert(hash);}
                            }
                        }
                    }
                }
            }
            for kw in &keywords {
                if sources.len() >= 3 { break; }
                let pattern = kw.trim();
                if pattern.is_empty() { continue; }
                let sql = "SELECT id, body, quote, created_at FROM conversation_notes
                           WHERE (instr(lower(body), lower(?1)) > 0 OR instr(lower(quote), lower(?1)) > 0)
                           ORDER BY created_at DESC LIMIT 2";
                if let Ok(mut stmt) = conn.prepare(sql) {
                    if let Ok(rows) = stmt.query_map([pattern], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
                    }) {
                        for row in rows.flatten() {
                            if sources.len() >= 3 { break; }
                            let (id, body, quote) = row;
                            if !seen_ids.insert(format!("conversation_note:{}", id)) { continue; }
                            let full_text = if quote.trim().is_empty() {
                                body
                            } else {
                                format!("{}\n原文摘录：{}", body, quote)
                            };
                            let (clipped, truncated) = excerpt(&full_text, pattern);
                            let source = Source::note(
                                id,
                                String::new(),
                                "对话笔记".into(),
                                String::new(),
                                clipped,
                                truncated,
                                None,
                            );
                            sources.push(source);
                        }
                    }
                }
            }
        }
    }

    // 2. Search Confirmed Ideas (ideas with confirmedBy='human')
    for kw in &keywords {
        if sources.len() >= 4 {
            break;
        }
        let pattern = kw.trim();
        if pattern.is_empty() {
            continue;
        }

        let sql = "SELECT data FROM ideas \
                   WHERE json_extract(data, '$.confirmedBy') = 'human' \
                     AND (instr(lower(json_extract(data, '$.title')), lower(?1)) > 0 \
                          OR instr(lower(json_extract(data, '$.body')), lower(?1)) > 0 \
                          OR instr(lower(json_extract(data, '$.question')), lower(?1)) > 0) \
                   ORDER BY json_extract(data, '$.createdAt') DESC \
                   LIMIT 2";

        let mut stmt = match store.db.prepare(sql) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let rows = match stmt.query_map(rusqlite::params![pattern], |row| row.get::<_, String>(0)) {
            Ok(r) => r,
            Err(_) => continue,
        };

        for raw in rows.flatten() {
            if sources.len() >= 4 {
                break;
            }
            let idea: crate::reflect::Idea = match serde_json::from_str(&raw) {
                Ok(i) => i,
                Err(_) => continue,
            };

            if !seen_ids.insert(format!("idea:{}", idea.id)) {
                continue;
            }

            let full_text = format!("【{}】\n{}", idea.title, idea.body);
            let clipped = clip(&full_text, 900);
            let truncated = clipped.len() < full_text.len();

            let source = Source::idea(idea.id, idea.title, clipped, truncated);
            sources.push(source);
        }
    }

    // 3. Search Obsidian Vault documents via derived VaultIndex
    if let Some(scope) = &vault_scope {
        let temp_dir;
        let db_path = match index_db_path {
            Some(p) => p.to_path_buf(),
            None => {
                // If not explicitly provided, open in temporary or standard location
                temp_dir = tempfile::tempdir().ok();
                temp_dir.as_ref().map(|d| d.path().join("assistant-library.sqlite3")).unwrap_or_else(|| PathBuf::from("assistant-library.sqlite3"))
            }
        };

        if let Ok(mut vault_idx) = VaultIndex::open(&db_path) {
            match vault_idx.sync_vault(scope) {
                Ok(report) => {
                    partial |= !report.complete || report.skipped_oversize > 0;
                    scope_description.push_str(&format!("；Vault 本次检查 {} 个文件{}",report.total_indexed,if partial {"，索引范围尚不完整，未命中不代表不存在"} else {""}));
                }
                Err(_) => { partial = true; scope_description.push_str("；Vault 索引暂不可用，未命中不代表不存在"); }
            }
            let mut vault_keywords = keywords.clone();
            vault_keywords.sort_by_key(|keyword|std::cmp::Reverse(keyword.chars().count()));
            // Deduplication must precede the two-document delivery budget.
            let vault_candidates = vault_idx.search(&vault_keywords, scope, 32);
            let mut vault_count = 0;

            for (rel_path, excerpt_text, live_hash) in vault_candidates {
                if sources.len() >= 6 || vault_count >= 2 {
                    break;
                }

                // Deduplicate exported markdown copies of Reader notes
                if note_hashes.contains(&live_hash) {
                    continue;
                }

                let truncated = excerpt_text.chars().count() >= 900;
                let clipped = clip(&excerpt_text, 900);
                let source = Source::vault(rel_path, clipped, truncated);

                if !seen_ids.insert(format!("vault:{}", source.id)) {
                    continue;
                }

                sources.push(source);
                vault_count += 1;
            }
        } else { partial = true; scope_description.push_str("；Vault 索引暂不可用"); }
    }

    let matched_count = sources.len();
    LibrarySearchResult {
        sources,
        coverage_scope: scope_description,
        matched_count, partial,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_second_same_size_edits_are_reindexed_and_deletions_are_not_served() {
        let dir=tempfile::tempdir().unwrap(); let root=fs::canonicalize(dir.path()).unwrap();
        let path=root.join("a.md"); let mut index=VaultIndex::open(&root.join("index.sqlite3")).unwrap();
        let scope=ResolvedVaultScope {vault_path:root.clone(),search_dir:root.clone(),is_custom:false};
        fs::write(&path,"边界甲").unwrap();
        let stamp=std::time::UNIX_EPOCH+std::time::Duration::new(100,1);
        fs::File::options().write(true).open(&path).unwrap().set_times(fs::FileTimes::new().set_modified(stamp)).unwrap();
        index.sync_vault(&scope).unwrap(); assert_eq!(index.search(&["边界".into()],&scope,6).len(),1);
        fs::write(&path,"天空乙").unwrap();
        fs::File::options().write(true).open(&path).unwrap().set_times(fs::FileTimes::new().set_modified(stamp+std::time::Duration::from_nanos(1))).unwrap();
        index.sync_vault(&scope).unwrap(); assert_eq!(index.search(&["天空".into()],&scope,6).len(),1);
        fs::remove_file(path).unwrap(); assert!(index.search(&["天空".into()],&scope,6).is_empty());
    }
    #[cfg(unix)]
    #[test]
    fn replaced_ancestor_symlink_cannot_supply_vault_content() {
        let dir=tempfile::tempdir().unwrap(); let root=fs::canonicalize(dir.path()).unwrap();
        fs::create_dir(root.join("vault")).unwrap(); fs::create_dir(root.join("vault/A")).unwrap();
        fs::write(root.join("vault/A/a.md"),"边界本地").unwrap();
        let scope=ResolvedVaultScope {vault_path:root.join("vault"),search_dir:root.join("vault"),is_custom:false};
        let mut index=VaultIndex::open(&root.join("index.sqlite3")).unwrap(); index.sync_vault(&scope).unwrap();
        fs::rename(root.join("vault/A"),root.join("outside")).unwrap();
        std::os::unix::fs::symlink(root.join("outside"),root.join("vault/A")).unwrap();
        assert!(index.search(&["边界".into()],&scope,6).is_empty());
    }
    #[test]
    fn incomplete_vault_scan_reports_its_limit() {
        let dir=tempfile::tempdir().unwrap(); let root=fs::canonicalize(dir.path()).unwrap();
        for n in 0..513 { fs::write(root.join(format!("{n}.md")),"边界").unwrap(); }
        let mut index=VaultIndex::open(&root.join("index.sqlite3")).unwrap();
        let report=index.sync_vault(&ResolvedVaultScope {vault_path:root.clone(),search_dir:root,is_custom:false}).unwrap();
        assert!(!report.complete); assert!(report.total_indexed<=512);
    }
    #[test]
    fn unicode_excerpt_uses_original_byte_boundaries() {
        let (text, _) = excerpt("İ中文边界", "边界");
        assert!(text.contains("边界"));
    }
    #[test]
    fn custom_scope_change_removes_outside_candidates() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("vault");
        fs::create_dir_all(vault.join("A")).unwrap(); fs::create_dir_all(vault.join("B")).unwrap();
        fs::write(vault.join("A/a.md"), "边界 A").unwrap();
        fs::write(vault.join("B/b.md"), "边界 B").unwrap();
        let mut index = VaultIndex::open(&dir.path().join("index.sqlite3")).unwrap();
        let vault=fs::canonicalize(vault).unwrap();
        let all = ResolvedVaultScope {vault_path:vault.clone(),search_dir:vault.clone(),is_custom:false};
        index.sync_vault(&all).unwrap();
        let restricted = ResolvedVaultScope {search_dir:vault.join("A"), ..all};
        // Search must enforce the current boundary even before its first sync.
        let hits=index.search(&["边界".into()], &restricted, 6);
        assert_eq!(hits.len(),1); assert!(hits.iter().all(|r|r.0.starts_with("A/")));
    }
    #[test]
    fn test_extract_keywords_quotes_and_segments() {
        let kw1 = extract_keywords("我们在之前的笔记里讨论过「注意力机制」吗？");
        assert_eq!(kw1, vec!["注意力机制"]);
        assert_eq!(extract_keywords("检索「界」"),vec!["界"]);

        let kw2 = extract_keywords("请问分类和复杂度的关系是什么？");
        assert!(kw2.contains(&"分类".to_string()) || kw2.contains(&"复杂度".to_string()));

        let kw3 = extract_keywords("What does Transformer do in my notes?");
        assert!(kw3.iter().any(|k| k.eq_ignore_ascii_case("transformer")));
    }

    #[test]
    fn test_vault_auto_inheritance_incremental_indexing_and_deduplication() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();

        // 1. Setup a test Obsidian Vault
        let vault_dir = dir.path().join("test_vault");
        fs::create_dir_all(vault_dir.join(".obsidian")).unwrap();
        let notes_dir = vault_dir.join("Notes");
        fs::create_dir_all(&notes_dir).unwrap();

        let doc1 = notes_dir.join("Cognitive.md");
        fs::write(&doc1, "# 认知负荷\n工作记忆在处理复杂概念时容量有限。\n涌现性是系统整体特有的属性。").unwrap();

        // 2. Configure vault in store
        let vault_cfg = crate::vault::VaultConfig {
            path: vault_dir.to_string_lossy().to_string(),
        };
        store.db.execute(
            "INSERT INTO settings(key, data) VALUES ('vault', ?1)",
            rusqlite::params![serde_json::to_string(&vault_cfg).unwrap()],
        ).unwrap();

        // 3. Test resolve_vault_scope (auto-inheritance without picking directory again)
        let resolved = resolve_vault_scope(&store).expect("should auto inherit vault_config");
        assert_eq!(fs::canonicalize(&resolved.vault_path).unwrap(), fs::canonicalize(&vault_dir).unwrap());
        assert!(!resolved.is_custom);

        // 4. Test incremental index sync and two-char Chinese search
        let index_db_path = dir.path().join("assistant-library.sqlite3");
        let mut idx = VaultIndex::open(&index_db_path).unwrap();
        let report = idx.sync_vault(&resolved).unwrap();
        assert_eq!(report.total_indexed, 1);
        assert_eq!(report.skipped_oversize, 0);

        // Two-character Chinese keyword search ("涌现")
        let hits = idx.search(&["涌现".into()], &resolved, 5);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].0.ends_with("Cognitive.md"));
        assert!(hits[0].1.contains("涌现性"));

        // 5. Test content modification immediately refreshes and doesn't return stale text
        fs::write(&doc1, "# 认知更新\n最新研究重新定义了系统涌现理论。").unwrap();
        // Live check in search detects change
        let hits_after = idx.search(&["涌现".into()], &resolved, 5);
        assert_eq!(hits_after.len(), 1);
        assert!(hits_after[0].1.contains("最新研究重新定义了系统涌现理论"));

        // 6. Test file deletion immediately invalidates search result
        fs::remove_file(&doc1).unwrap();
        let hits_deleted = idx.search(&["涌现".into()], &resolved, 5);
        assert_eq!(hits_deleted.len(), 0);

        // 7. Test search_local_library integrating Reader notes, ideas, and Vault with deduplication
        let book_id = "a".repeat(64);
        let book = Book {
            id: book_id.clone(),
            fingerprint: book_id.clone(),
            title: "系统科学".into(),
            author: "作者".into(),
            language: "zh".into(),
            cover: None,
            imported_at: chrono::Utc::now().to_rfc3339(),
        };
        store.db.execute(
            "INSERT INTO books(id, fingerprint, data) VALUES (?1, ?2, ?3)",
            rusqlite::params![book.id, book.fingerprint, serde_json::to_string(&book).unwrap()],
        ).unwrap();

        let note = Annotation {
            id: "note-1".into(),
            book_id: book.id.clone(),
            fingerprint: book.fingerprint.clone(),
            cfi: "epubcfi(/6/2)".into(),
            href: "ch1.xhtml".into(),
            quote: "自组织现象".into(),
            kind: "note".into(),
            body: "系统的自组织与复杂性密切相关。".into(),
            session_id: "s1".into(),
            created_at: chrono::Utc::now().to_rfc3339(),
            updated_at: chrono::Utc::now().to_rfc3339(),
            chapter_label: "第一章".into(),
            created_by: "human".into(),
        };
        store.db.execute(
            "INSERT INTO annotations(id, book_id, data) VALUES (?1, ?2, ?3)",
            rusqlite::params![note.id, note.book_id, serde_json::to_string(&note).unwrap()],
        ).unwrap();

        // Create a new markdown file in Vault with new content
        let doc2 = notes_dir.join("Complexity.md");
        fs::write(&doc2, "复杂系统的自组织动力学模型。").unwrap();

        // Also record an exported markdown path for note-1 to test deduplication
        let export_record = crate::vault::ExportRecord {
            note_id: note.id.clone(),
            vault_path: fs::canonicalize(&vault_dir).unwrap().to_string_lossy().to_string(),
            relative_path: "Notes/Complexity.md".into(),
            content_hash: Some(format!("{:x}",Sha256::digest(fs::read(&doc2).unwrap()))),
            source_hash: None,
            exported_at: None,
            status: "exported".into(),
            message: None,
            conflict_path: None,
            backup_path: None,
        };
        store.db.execute(
            "INSERT INTO vault_exports(vault_path, note_id, data) VALUES (?1, ?2, ?3)",
            rusqlite::params![export_record.vault_path, export_record.note_id, serde_json::to_string(&export_record).unwrap()],
        ).unwrap();

        // Search for "自组织" -> note should be included, while the exported markdown copy is deduplicated!
        let search_res = search_local_library(&store, "复杂系统的自组织", Some(&book.id), Some(&index_db_path));
        assert!(search_res.matched_count >= 1);
        assert!(search_res.sources.iter().any(|s| s.kind == "note" && s.text.contains("自组织")));
        // The duplicate vault file was deduplicated!
        assert!(!search_res.sources.iter().any(|s| s.kind == "vault" && s.fingerprint == "Notes/Complexity.md"));

        for n in 0..4 {fs::write(notes_dir.join(format!("AAA-duplicate-{n}.md")),fs::read(&doc2).unwrap()).unwrap();}
        fs::write(&doc2, "复杂系统的自组织动力学模型。外部修改：边界变化。" ).unwrap();
        let modified = search_local_library(&store, "「自组织」", Some(&book.id), Some(&index_db_path));
        assert!(modified.sources.iter().any(|s|s.kind=="vault" && s.text.contains("外部修改")));

        // Verify all returned sources pass assistant Input::validate()
        let mut input = crate::assistant::Input::empty("自组织".into());
        input.sources = search_res.sources;
        assert!(input.validate().is_ok());

        // 8. Test clearing index when switching or disconnecting vault
        store.db.execute("DELETE FROM settings WHERE key='vault'", []).unwrap();
        let unlinked_res = search_local_library(&store, "自组织", Some(&book.id), Some(&index_db_path));
        assert!(unlinked_res.coverage_scope.contains("Vault 未连接"));
        let cleared=VaultIndex::open(&index_db_path).unwrap();
        assert_eq!(cleared.db.query_row("SELECT count(*) FROM docs",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }
}
