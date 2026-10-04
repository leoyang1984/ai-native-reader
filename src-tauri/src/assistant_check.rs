//! Opt-in debug acceptance runner. Uses the production native host and an isolated
//! temporary Reader root. Only project-authored sample text is sent to the model.
use crate::{assistant::{AssistantService,Input,Source,Event},codex::CodexHost};
use serde_json::Value;
use sha2::{Digest,Sha256};
use std::{sync::{Arc,mpsc},time::{Duration,Instant},ops::Deref};
struct CheckedHost(CodexHost);
impl Deref for CheckedHost {type Target=CodexHost;fn deref(&self)->&CodexHost {&self.0}}
impl Drop for CheckedHost {fn drop(&mut self) {self.0.shutdown();}}

type Result<T> = std::result::Result<T,String>;
const TEXT:&str="分类减少的是系统需要处理的复杂度。它让一个机构能够比较不同的对象，让陌生人能够使用共同的词语交流。但被省略的部分并没有从现实中消失，它们只是暂时离开了表格。";
fn host(root:&std::path::Path,service:AssistantService) -> Result<(CheckedHost,mpsc::Receiver<(String,Value)>)> {
    let (tx,rx)=mpsc::channel();
    let host=CodexHost::with_sink(root,service,Arc::new(move|name,value|{let _=tx.send((name.into(),value));}))?;
    Ok((CheckedHost(host),rx))
}
fn check(condition:bool,label:&str) -> Result<()> { if condition {println!("PASS {label}");Ok(())} else {Err(format!("FAIL {label}"))} }
fn wait(rx:&mpsc::Receiver<(String,Value)>,request:&str) -> Result<Event> {
    let deadline=Instant::now()+Duration::from_secs(100);let mut progress=false;
    loop {
        let (name,value)=rx.recv_timeout(deadline.saturating_duration_since(Instant::now())).map_err(|_|"等待助手回复超时。")?;
        if name!="assistant-turn" || value["requestId"]!=request {continue;}
        let event:Event=serde_json::from_value(value).map_err(|_|"验收事件无效。")?;
        if event.status=="streaming" {
            if !event.body.is_empty() {progress=true;}
            if event.body.starts_with("{\"schemaVersion") { return Err("流式展示泄露原始 JSON。".into()); }
            continue;
        }
        if event.status=="cancelling" {continue;}
        println!("turn status={} streamed={progress}",event.status);
        return Ok(event);
    }
}
fn send(host:&CodexHost,rx:&mpsc::Receiver<(String,Value)>,conversation:&str,request:&str,input:Input) -> Result<Event> {
    let time=Instant::now();
    host.start_assistant(conversation.into(),request.into(),input,host.status()?.generation)?;
    let event=wait(rx,request)?;println!("turn elapsedMs={}",time.elapsed().as_millis());
    if event.status=="failed" {return Err(format!("助手验收答复未通过：{}",event.message));}Ok(event)
}
pub fn run() -> Result<()> {
    let root=tempfile::tempdir().map_err(|_|"无法建立验收目录。")?;
    let service=AssistantService::open(root.path());
    service.create("story".into(),"原创样书讨论".into(),None)?;
    let (host,rx)=host(root.path(),service.clone())?;
    let connected=host.connect(host.status()?.executable)?;
    println!("protocol={} connected={}",connected.version.as_deref().unwrap_or("unknown"),connected.phase=="ready");
    let mut input=Input::empty("用一句话解释这段原文，并记住我们将这一讨论称作「小路讨论」。请引用原文。".into());
    let fingerprint=format!("{:x}",Sha256::digest(include_bytes!("../../public/samples/reader-lab.epub")));
    input.sources.push(Source::book(fingerprint,"分类与现实 · A Reader’s Fieldbook".into(),TEXT.into(),false,None));
    let first=send(&host,&rx,"story","first",input)?;
    check(first.status=="completed" && first.answer.as_ref().is_some_and(|a| !a.citations.is_empty()),"original sample with validated citation")?;
    let thread=first.thread_id;
    let second=send(&host,&rx,"story","followup",Input::empty("我们给这场讨论起的名字是什么？再说明被省略的细节去了哪里。".into()))?;
    check(second.status=="completed" && second.thread_id==thread && second.body.contains("小路讨论"),"same thread remembers first turn")?;
    let third=send(&host,&rx,"story","followup-two",Input::empty("请继续用我们给讨论起的名字开头，再把「暂时离开了表格」解释成一个贴近阅读的比喻。".into()))?;
    check(third.status=="completed" && third.thread_id==thread && third.body.contains("小路讨论"),"second consecutive follow-up keeps discussion context")?;
    // A planner-like ephemeral turn must not steal the discussion's binding.
    host.start_ephemeral("planner".into(),"返回 JSON：answer 为「临时规划」，schemaVersion=1，citations=[]，proposal=null。".into(),host.status()?.generation,Some(crate::assistant::output_schema()))?;
    loop {
        let (name,value)=rx.recv_timeout(Duration::from_secs(100)).map_err(|_|"临时请求超时。")?;
        if name=="codex-turn" && value["requestId"]=="planner" && ["completed","failed","cancelled"].contains(&value["status"].as_str().unwrap_or("")) {
            check(value["status"]=="completed" && value["threadId"]!=thread,"ephemeral planner uses separate thread")?;break;
        }
    }
    check(service.load("story",None)?.conversation.thread_id.as_deref()==Some(thread.as_str()),"planner preserves durable conversation binding")?;
    let generation=host.status()?.generation;
    host.start_assistant("story".into(),"stop".into(),Input::empty("请详细讨论分类与细节，写十段，每段一百字。".into()),generation)?;
    host.cancel("stop".into())?;
    let stopped=wait(&rx,"stop")?;
    check(stopped.status=="cancelled","stop yields cancelled record")?;
    service.draft("story","明天继续讨论分类")?;
    host.disconnect();drop(host);drop(service);
    let reopened=AssistantService::open(root.path());
    let history=reopened.load("story",None)?;
    check(history.messages.len()==8 && history.conversation.draft=="明天继续讨论分类" && history.messages.last().is_some_and(|m|m.status=="cancelled"),"restart restores history draft and cancellation")?;
    // Restart the Reader executable itself, not just its Rust service objects.
    drop(reopened);
    let status=std::process::Command::new(std::env::current_exe().map_err(|_|"无法定位验收程序。")?)
        .arg("--assistant-check-resume").arg(root.path()).status().map_err(|_|"无法启动恢复验收进程。")?;
    check(status.success(),"fresh Reader process completed recovery")?;
    let reopened=AssistantService::open(root.path());let history=reopened.load("story",None)?;
    check(history.messages.len()==10 && history.conversation.thread_id.as_deref()==Some(thread.as_str()),"no replayed messages or replaced thread")?;
    println!("M5-01 live acceptance passed (isolated sample; no private books or Vault)");
    Ok(())
}

/// Called only by the opt-in debug runner with its private temporary directory.
pub fn resume(root:&std::path::Path) -> Result<()> {
    let service=AssistantService::open(root);
    let history=service.load("story",None)?;
    let original=history.conversation.thread_id.ok_or("缺少验收线程。")?;
    let (host,rx)=host(root,service)?;
    host.connect(host.status()?.executable)?;
    let event=send(&host,&rx,"story","resumed",Input::empty("我们昨天给讨论起的名字是什么？只回答这个名字。".into()))?;
    check(event.status=="completed" && event.thread_id==original && event.body.contains("小路讨论"),"new Reader/app-server process resumes original thread without history injection")?;
    host.shutdown();Ok(())
}
