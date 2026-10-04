use crate::{context::ContextHub, store::Store};
use std::sync::Mutex;

pub type Result<T> = std::result::Result<T, String>;
pub struct Database(pub Mutex<Store>);
pub struct RuntimeContext(pub Mutex<ContextHub>);
pub fn locked(db: &Database) -> Result<std::sync::MutexGuard<'_, Store>> {
    db.0.lock().map_err(|_| "数据库暂不可用，请重新打开应用。".into())
}
pub fn context_locked(state: &RuntimeContext) -> Result<std::sync::MutexGuard<'_, ContextHub>> {
    state.0.lock().map_err(|_| "阅读上下文暂不可用，请重新打开应用。".into())
}
