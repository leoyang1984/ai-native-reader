//! Provider facade preserves existing event/command names and fences generations across providers.
use crate::{assistant::{AssistantService, Input}, codex::CodexHost, pi::PiHost};
use serde_json::{json, Value};
use std::{fs, path::{Path,PathBuf}, sync::{Arc,Mutex,atomic::{AtomicU64,AtomicU8,Ordering}}};
use tauri::Emitter;
type Result<T> = std::result::Result<T,String>;
const BASE:u64=1u64<<32;
struct Gate { provider:AtomicU8, epoch:AtomicU64 }
struct Core { service:AssistantService, codex:CodexHost, pi:PiHost, gate:Arc<Gate>, operations:Mutex<()>, settings:PathBuf, emit:Arc<dyn Fn(&str,Value)+Send+Sync> }
#[derive(Clone)]
pub struct AgentHost(Arc<Core>);
impl AgentHost {
    pub fn new(app:tauri::AppHandle,root:&Path,service:AssistantService) -> Result<Self> {
        let provider=fs::read(root.join("agent-connection.json")).ok().filter(|b|b.len()<1024).and_then(|b|serde_json::from_slice::<Value>(&b).ok()).is_some_and(|v|v["provider"]=="pi");
        let gate=Arc::new(Gate {provider:AtomicU8::new(if provider {1} else {0}),epoch:AtomicU64::new(1)});
        let emit:Arc<dyn Fn(&str,Value)+Send+Sync>=Arc::new(move|name,value|{let _=app.emit(name,value);});
        let sink=|provider:u8| {let gate=gate.clone();let emit=emit.clone();Arc::new(move|name:&str,mut value:Value| {
            if gate.provider.load(Ordering::Acquire)!=provider {return;}
            let generation=value["generation"].as_u64().unwrap_or(0);
            value["generation"]=json!(gate.epoch.load(Ordering::Acquire)*BASE+generation);
            if name=="codex-status" {value["provider"]=json!(if provider==1 {"pi"} else {"codex"});}
            emit(name,value);
        }) as Arc<dyn Fn(&str,Value)+Send+Sync>};
        Ok(Self(Arc::new(Core {codex:CodexHost::with_sink(root,service.clone(),sink(0))?,pi:PiHost::new(root,service.clone(),sink(1))?,service,gate,operations:Mutex::new(()),settings:root.join("agent-connection.json"),emit})))
    }
    pub fn shared(&self)->Self {self.clone()}
    fn is_pi(&self)->bool {self.0.gate.provider.load(Ordering::Acquire)==1}
    pub fn status(&self)->Result<Value> {
        let status=if self.is_pi() {self.0.pi.status()?} else {self.0.codex.status()?};
        let mut value=serde_json::to_value(status).map_err(|_|"助手状态不可用。")?;
        value["generation"]=json!(self.0.gate.epoch.load(Ordering::Acquire)*BASE+value["generation"].as_u64().unwrap_or(0));value["provider"]=json!(if self.is_pi() {"pi"} else {"codex"});Ok(value)
    }
    pub fn select(&self,provider:String)->Result<Value> {
        let _op=self.0.operations.lock().map_err(|_|"助手设置不可用。")?;self.select_inner(&provider)?;self.status()
    }
    fn select_inner(&self,provider:&str)->Result<()> {
        let pi=match provider {"pi"=>true,"codex"=>false,_=>return Err("未知的助手类型。".into())};
        if pi==self.is_pi() {return Ok(());}
        let phase=self.status()?["phase"].as_str().unwrap_or("").to_owned();
        if matches!(phase.as_str(),"running"|"cancelling"|"connecting") {return Err("请先停止当前请求，再切换助手。".into());}
        // Persist the selection before changing the live provider.
        let mut file=tempfile::NamedTempFile::new_in(self.0.settings.parent().unwrap()).map_err(|_|"无法保存助手选择。")?;
        serde_json::to_writer(&mut file,&json!({"provider":provider})).map_err(|_|"无法保存助手选择。")?;file.persist(&self.0.settings).map_err(|_|"无法保存助手选择。")?;
        if self.is_pi() {self.0.pi.disconnect();} else {self.0.codex.disconnect();}
        self.0.gate.epoch.fetch_add(1,Ordering::AcqRel);self.0.gate.provider.store(if pi {1} else {0},Ordering::Release);
        (self.0.emit)("codex-status",self.status()?);Ok(())
    }
    pub fn connect(&self,executable:String)->Result<Value> {
        let _op=self.0.operations.lock().map_err(|_|"助手连接任务不可用。")?;
        let phase=self.status()?["phase"].as_str().unwrap_or("").to_owned();if matches!(phase.as_str(),"running"|"cancelling"|"connecting") {return Err("请先停止当前请求，再重新连接。".into());}
        if self.is_pi() {self.0.pi.connect(executable)?;} else {self.0.codex.connect(executable)?;}self.status()
    }
    fn generation(&self,generation:u64)->Result<u64> {
        if generation/BASE!=self.0.gate.epoch.load(Ordering::Acquire) {return Err("助手连接已经变化，请重试。".into());}Ok(generation%BASE)
    }
    pub fn start(&self,request:String,text:String,fresh:bool,generation:u64,schema:Option<Value>)->Result<()> {
        let _op=self.0.operations.lock().map_err(|_|"助手请求不可用。")?;let generation=self.generation(generation)?;
        if self.is_pi() {self.0.pi.start(request,text,fresh,generation,schema)} else {self.0.codex.start(request,text,fresh,generation,schema)}
    }
    pub fn start_assistant(&self,conversation:String,request:String,input:Input,generation:u64)->Result<()> {
        let _op=self.0.operations.lock().map_err(|_|"助手请求不可用。")?;let generation=self.generation(generation)?;
        let page=self.0.service.load(&conversation,None)?;
        if let Some(thread)=page.conversation.thread_id {
            if thread.starts_with("pi:")!=self.is_pi() {return Err("此对话来自其他助手，请保留历史并开启新对话。".into());}
        }
        if self.is_pi() {self.0.pi.start_assistant(conversation,request,input,generation)} else {self.0.codex.start_assistant(conversation,request,input,generation)}
    }
    pub fn cancel(&self,request:String)->Result<()> {if self.is_pi() {self.0.pi.cancel(request)} else {self.0.codex.cancel(request)}}
    pub fn disconnect(&self) {if self.is_pi() {self.0.pi.disconnect();} else {self.0.codex.disconnect();}}
    pub fn shutdown(&self) {self.0.pi.disconnect();self.0.codex.shutdown();}
}
