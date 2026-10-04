//! Versioned, bounded snapshots shared by the desktop UI and the future MCP service.
use crate::store::Store;
use chrono::{DateTime, Utc};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

type Result<T> = std::result::Result<T, String>;
pub const SCHEMA_VERSION: u32 = 1;
pub const MAX_AGE_MS: u64 = 30_000;

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ContextStatus { NoBook, Opening, Reading, NotReading }
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ContextView { Library, Reader, Session, Reflect }
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TextState { Pending, Ready, Unavailable, NotApplicable }
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TextAnchor { Position, Selection }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnavailableReason { ChapterNotRendered, AnchorNotFound, ChapterLimit }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextBook { pub id: String, pub fingerprint: String, pub title: String, pub author: String, pub language: String }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextLocation { pub cfi: String, pub href: String, pub chapter_label: String, pub percent: Option<f64> }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextExcerpt { pub cfi: String, pub href: String, pub text: String, pub characters: usize, pub truncated: bool }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurroundingText {
    pub anchor: TextAnchor, pub anchor_cfi: String, pub href: String,
    pub before: Option<ContextExcerpt>, pub focus: Option<ContextExcerpt>, pub after: Option<ContextExcerpt>,
    pub unavailable_reason: Option<UnavailableReason>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextSession { pub id: String, pub started_at: String, pub updated_at: String, pub active_seconds: f64 }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadingContext {
    pub schema_version: u32, pub instance_id: String, pub revision: u64, pub captured_at: String,
    pub status: ContextStatus, pub view: ContextView, pub foreground: bool,
    pub book: Option<ContextBook>, pub location: Option<ContextLocation>, pub session: Option<ContextSession>,
    pub selection: Option<ContextExcerpt>, pub text_state: TextState, pub surrounding: Option<SurroundingText>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Availability { Live, Stale, Initializing, NotRunning }
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ContextSource { Runtime, Persisted }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextSnapshot {
    pub schema_version: u32, pub source: ContextSource, pub availability: Availability, pub observed_at: String,
    pub is_stale: bool, pub max_age_ms: u64, pub current: Option<ReadingContext>, pub last_known_reading: Option<ReadingContext>,
}

fn invalid() -> String { "阅读上下文的版本、来源或内容不完整。".into() }
fn bounded(value: &str, max: usize) -> bool { value.encode_utf16().count() <= max }
fn cfi(value: &str) -> bool { bounded(value, 8_192) && value.starts_with("epubcfi(") && value.ends_with(')') }
fn href(value: &str) -> bool { !value.is_empty() && bounded(value, 2_048) && !value.contains('\0') }
fn date(value: &str) -> bool { DateTime::parse_from_rfc3339(value).is_ok() }
fn uuid(value: &str) -> bool { value.len() == 36 && value.bytes().enumerate().all(|(i, b)| if [8, 13, 18, 23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() }) }
impl ContextExcerpt {
    fn validate(&self, max: usize, expected_href: &str) -> bool {
        cfi(&self.cfi) && self.href == expected_href && self.characters == self.text.encode_utf16().count()
            && self.characters > 0 && self.characters <= max
    }
}
impl ReadingContext {
    fn validate_shape(&self) -> Result<()> {
        if self.schema_version != SCHEMA_VERSION || !uuid(&self.instance_id) || self.revision == 0 || self.revision > 9_007_199_254_740_991 || !date(&self.captured_at) { return Err(invalid()); }
        if let Some(book) = &self.book {
            if book.id.len() != 64 || book.id != book.fingerprint || !book.id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || !bounded(&book.title, 4_096) || !bounded(&book.author, 4_096) || !bounded(&book.language, 256) { return Err(invalid()); }
        }
        if let Some(location) = &self.location {
            if self.book.is_none() || !cfi(&location.cfi) || !href(&location.href) || !bounded(&location.chapter_label, 4_096)
                || location.percent.is_some_and(|p| !p.is_finite() || !(0.0..=1.0).contains(&p)) { return Err(invalid()); }
        }
        if let Some(session) = &self.session {
            if self.book.is_none() || !uuid(&session.id) || !date(&session.started_at) || !date(&session.updated_at)
                || !session.active_seconds.is_finite() || session.active_seconds < 0.0 { return Err(invalid()); }
        }
        if self.status == ContextStatus::NoBook || self.status == ContextStatus::Opening {
            if self.book.is_some() || self.location.is_some() || self.session.is_some() { return Err(invalid()); }
        } else if self.book.is_none() { return Err(invalid()); }
        if self.status == ContextStatus::Reading {
            if self.view != ContextView::Reader || self.location.is_none() || self.session.is_none() || self.text_state == TextState::NotApplicable { return Err(invalid()); }
        } else if self.selection.is_some() || self.surrounding.is_some() || self.text_state != TextState::NotApplicable { return Err(invalid()); }
        if let Some(selection) = &self.selection {
            if !selection.validate(4_000, &self.location.as_ref().ok_or_else(invalid)?.href) { return Err(invalid()); }
        }
        if let Some(text) = &self.surrounding {
            let location = self.location.as_ref().ok_or_else(invalid)?;
            let anchor = self.selection.as_ref().map(|s| &s.cfi).unwrap_or(&location.cfi);
            if text.href != location.href || &text.anchor_cfi != anchor || (text.anchor == TextAnchor::Selection) != self.selection.is_some()
                || [text.before.as_ref(), text.focus.as_ref(), text.after.as_ref()].iter().flatten().any(|e| !e.validate(1_200, &text.href)) { return Err(invalid()); }
            if text.unavailable_reason.is_some() {
                if self.text_state != TextState::Unavailable || text.before.is_some() || text.focus.is_some() || text.after.is_some() { return Err(invalid()); }
            } else if self.text_state != TextState::Ready || text.focus.is_none() { return Err(invalid()); }
        } else if self.text_state == TextState::Ready { return Err(invalid()); }
        Ok(())
    }
    pub fn validate(&self, store: &Store) -> Result<()> {
        self.validate_shape()?;
        if let Some(book) = &self.book {
            let fingerprint: String = store.db.query_row("SELECT fingerprint FROM books WHERE id=?1", [&book.id], |r| r.get(0)).map_err(|_| invalid())?;
            if fingerprint != book.fingerprint { return Err(invalid()); }
        }
        if let Some(session) = &self.session {
            let book_id: String = store.db.query_row("SELECT book_id FROM sessions WHERE id=?1", [&session.id], |r| r.get(0)).map_err(|_| invalid())?;
            if Some(&book_id) != self.book.as_ref().map(|b| &b.id) { return Err(invalid()); }
        }
        Ok(())
    }
}

impl ContextSnapshot {
    /// A disk snapshot is historical even if its timestamp is only milliseconds old.
    pub fn persisted(last_known_reading: Option<ReadingContext>) -> Self {
        Self { schema_version: SCHEMA_VERSION, source: ContextSource::Persisted, availability: Availability::Stale, observed_at: Utc::now().to_rfc3339(),
            is_stale: true, max_age_ms: MAX_AGE_MS, current: None, last_known_reading }
    }
}

pub struct ContextHub {
    instance_id: Option<String>, current: Option<ReadingContext>, received_at: Option<Instant>,
    last_known_reading: Option<ReadingContext>, running: bool,
}
impl ContextHub {
    pub fn new(last_known_reading: Option<ReadingContext>) -> Self {
        Self { instance_id: None, current: None, received_at: None, last_known_reading, running: true }
    }
    pub fn begin(&mut self, instance_id: String) -> Result<()> {
        if !uuid(&instance_id) { return Err(invalid()); }
        self.instance_id = Some(instance_id); self.current = None; self.received_at = None; self.running = true; Ok(())
    }
    pub fn publish(&mut self, context: ReadingContext) -> Result<()> {
        context.validate_shape()?;
        if !self.running || self.instance_id.as_deref() != Some(&context.instance_id)
            || self.current.as_ref().is_some_and(|c| c.revision >= context.revision) { return Err("旧的阅读上下文已失效。".into()); }
        if context.status == ContextStatus::Reading && context.text_state != TextState::Pending { self.last_known_reading = Some(context.clone()); }
        self.current = Some(context); self.received_at = Some(Instant::now()); Ok(())
    }
    pub fn snapshot(&self) -> ContextSnapshot {
        if !self.running {
            let mut snapshot = ContextSnapshot::persisted(self.last_known_reading.clone());
            snapshot.availability = Availability::NotRunning;
            return snapshot;
        }
        let fresh = self.received_at.is_some_and(|time| time.elapsed() <= Duration::from_millis(MAX_AGE_MS));
        ContextSnapshot { schema_version: SCHEMA_VERSION, source: ContextSource::Runtime, availability: if self.current.is_none() { Availability::Initializing } else if fresh { Availability::Live } else { Availability::Stale },
            observed_at: Utc::now().to_rfc3339(), is_stale: !fresh, max_age_ms: MAX_AGE_MS,
            current: if fresh { self.current.clone() } else { None }, last_known_reading: self.last_known_reading.clone() }
    }
    pub fn contains_snapshot(&self, snapshot: &ContextSnapshot) -> bool {
        snapshot.schema_version == SCHEMA_VERSION && snapshot.source == ContextSource::Runtime && snapshot.availability == Availability::Live
            && !snapshot.is_stale && snapshot.max_age_ms == MAX_AGE_MS && snapshot.current.as_ref().is_some_and(|value|
                self.current.as_ref().is_some_and(|current| current.instance_id == value.instance_id && current.revision >= value.revision))
    }
    pub fn stop(&mut self) { self.running = false; self.current = None; self.received_at = None; }
}

impl Store {
    pub fn last_reading_context(&self) -> Result<Option<ReadingContext>> {
        let raw: Option<String> = self.db.query_row("SELECT data FROM settings WHERE key='reading_context_v1'", [], |row| row.get(0)).optional().map_err(|e| e.to_string())?;
        // Derived cache data must never prevent books/notes from opening after an upgrade.
        Ok(raw.and_then(|raw| serde_json::from_str::<ReadingContext>(&raw).ok())
            .filter(|context| context.status == ContextStatus::Reading && context.text_state != TextState::Pending && context.validate(self).is_ok()))
    }
    pub fn save_reading_context(&self, context: &ReadingContext) -> Result<()> {
        if context.status != ContextStatus::Reading || context.text_state == TextState::Pending { return Ok(()); }
        let data = serde_json::to_string(context).map_err(|e| e.to_string())?;
        self.db.execute("INSERT INTO settings(key,data) VALUES ('reading_context_v1',?1) ON CONFLICT(key) DO UPDATE SET data=excluded.data", [data]).map_err(|e| format!("阅读上下文快照未保存：{e}"))?;
        Ok(())
    }
}
