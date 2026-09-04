//! JSON-RPC 2.0 over stdio: outbound line writer and request dispatch (docs/core-protocol.md).

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::agents::{self, Job};
use crate::store::{Part, Task};
use crate::Ctx;

/// Sender of complete JSON lines to the app; a single writer task drains it to stdout.
#[derive(Clone)]
pub struct Outbound(pub mpsc::UnboundedSender<String>);

impl Outbound {
    fn line(&self, v: Value) {
        // If the writer is gone the app has gone away; nothing useful to do.
        let _ = self.0.send(v.to_string());
    }

    pub fn notify(&self, method: &str, params: Value) {
        self.line(json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    pub fn request(&self, id: &str, method: &str, params: Value) {
        self.line(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
    }

    pub fn respond(&self, id: Value, result: Value) {
        self.line(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    }

    pub fn respond_error(&self, id: Value, code: i64, message: &str) {
        self.line(
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
        );
    }
}

pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl RpcError {
    fn invalid_params(message: impl Into<String>) -> Self {
        Self {
            code: -32602,
            message: message.into(),
        }
    }

    fn failed(message: impl Into<String>) -> Self {
        Self {
            code: -32000,
            message: message.into(),
        }
    }
}

impl From<anyhow::Error> for RpcError {
    fn from(e: anyhow::Error) -> Self {
        Self::failed(format!("{e:#}"))
    }
}

fn parse<T: for<'de> Deserialize<'de>>(params: Value) -> Result<T, RpcError> {
    serde_json::from_value(params).map_err(|e| RpcError::invalid_params(e.to_string()))
}

#[derive(Deserialize)]
struct ProjectId {
    project_id: String,
}
#[derive(Deserialize)]
struct TaskList {
    project_id: Option<String>,
}
#[derive(Deserialize)]
struct TaskId {
    task_id: String,
}
#[derive(Deserialize)]
struct ProjectCreate {
    name: String,
    path: String,
}
#[derive(Deserialize)]
struct ProjectRename {
    project_id: String,
    name: String,
}
#[derive(Deserialize)]
struct ProjectUpdate {
    project_id: String,
    name: String,
    path: String,
}
#[derive(Deserialize)]
struct TaskCreate {
    project_id: Option<String>,
    title: String,
}
#[derive(Deserialize)]
struct TaskRename {
    task_id: String,
    title: String,
}
#[derive(Deserialize)]
struct TaskAgent {
    task_id: String,
    agent: String,
}
#[derive(Deserialize)]
struct AgentId {
    agent: String,
}
/// What the app attaches to a message: images travel inline, files and folders by path.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Attachment {
    Image { mime_type: String, data: String },
    File { path: String },
}

impl Attachment {
    fn into_part(self) -> Part {
        match self {
            Attachment::Image { mime_type, data } => Part::Image { mime_type, data },
            Attachment::File { path } => {
                let name = std::path::Path::new(&path)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| path.clone());
                Part::File { path, name }
            }
        }
    }
}

#[derive(Deserialize)]
struct ChatSend {
    task_id: String,
    agent: String,
    text: String,
    #[serde(default)]
    attachments: Vec<Attachment>,
}
#[derive(Deserialize)]
struct ChatEdit {
    task_id: String,
    message_id: String,
    agent: String,
    text: String,
    #[serde(default)]
    attachments: Vec<Attachment>,
}
#[derive(Deserialize)]
struct ChatRetry {
    task_id: String,
    message_id: String,
    agent: String,
}
#[derive(Deserialize)]
struct AgentSetConfig {
    task_id: String,
    agent: String,
    config_id: String,
    value: Value,
}
#[derive(Deserialize)]
struct PermissionRespond {
    request_id: String,
    option_id: Option<String>,
}

/// Handle one app → core request and write its response.
pub async fn dispatch(ctx: Arc<Ctx>, id: Value, method: String, params: Value) {
    match handle(&ctx, &method, params).await {
        Ok(result) => ctx.out.respond(id, result),
        Err(e) => ctx.out.respond_error(id, e.code, &e.message),
    }
}

async fn handle(ctx: &Arc<Ctx>, method: &str, params: Value) -> Result<Value, RpcError> {
    let store = &ctx.store;
    let v = match method {
        "agent.list" => json!(ctx.agents.list()),
        "project.list" => json!(store.list_projects()?),
        "project.create" => {
            let p: ProjectCreate = parse(params)?;
            json!(store.create_project(&p.name, &p.path)?)
        }
        "project.rename" => {
            let p: ProjectRename = parse(params)?;
            let project = store
                .rename_project(&p.project_id, &p.name)?
                .ok_or_else(|| RpcError::invalid_params("unknown project_id"))?;
            json!(project)
        }
        "project.update" => {
            let p: ProjectUpdate = parse(params)?;
            let previous = store
                .get_project(&p.project_id)?
                .ok_or_else(|| RpcError::invalid_params("unknown project_id"))?;
            let project = store
                .update_project(&p.project_id, &p.name, &p.path)?
                .ok_or_else(|| RpcError::invalid_params("unknown project_id"))?;
            if previous.path != p.path {
                // Existing sessions keep their original working directory. Stop them so
                // the next connect starts cleanly inside the updated source folder.
                for task in store.list_tasks(Some(&p.project_id))? {
                    ctx.agents.drop_task(&task.id);
                }
            }
            json!(project)
        }
        "project.delete" => {
            let p: ProjectId = parse(params)?;
            // Sessions serving any Chat in this Project go with it.
            for task in store.list_tasks(Some(&p.project_id))? {
                ctx.agents.drop_task(&task.id);
            }
            if !store.delete_project(&p.project_id)? {
                return Err(RpcError::invalid_params("unknown project_id"));
            }
            json!({})
        }
        "task.list" => {
            let p: TaskList = parse(params)?;
            json!(store.list_tasks(p.project_id.as_deref())?)
        }
        "task.create" => {
            let p: TaskCreate = parse(params)?;
            if let Some(project_id) = p.project_id.as_deref() {
                if store.get_project(project_id)?.is_none() {
                    return Err(RpcError::invalid_params("unknown project_id"));
                }
            }
            json!(store.create_task(p.project_id.as_deref(), &p.title)?)
        }
        "task.context" => {
            let p: TaskId = parse(params)?;
            let (task, cwd) = task_context(ctx, &p.task_id)?;
            json!({ "task_id": task.id, "cwd": cwd })
        }
        "task.rename" => {
            let p: TaskRename = parse(params)?;
            let task = store
                .rename_task(&p.task_id, &p.title)?
                .ok_or_else(|| RpcError::invalid_params("unknown task_id"))?;
            json!(task)
        }
        "task.delete" => {
            let p: TaskId = parse(params)?;
            // Sessions serving the task go with it; their adapters exit.
            ctx.agents.drop_task(&p.task_id);
            if !store.delete_task(&p.task_id)? {
                return Err(RpcError::invalid_params("unknown task_id"));
            }
            json!({})
        }
        "chat.history" => {
            let p: TaskId = parse(params)?;
            let mut messages = store.list_messages(&p.task_id)?;
            for message in &mut messages {
                // Never append synthetic indices to an actively streaming transcript.
                if message.role == "assistant" && message.status != "streaming" {
                    crate::file_outputs::enrich(&mut message.parts);
                }
            }
            json!(messages)
        }
        "chat.events" => {
            let p: TaskId = parse(params)?;
            json!(store.list_events(&p.task_id)?)
        }
        "runtime.events" => {
            let task_id = params
                .get("task_id")
                .and_then(Value::as_str)
                .ok_or_else(|| RpcError::invalid_params("task_id is required"))?;
            store.runtime_events(
                task_id,
                params.get("after").and_then(Value::as_i64).unwrap_or(0),
                params.get("limit").and_then(Value::as_i64).unwrap_or(100),
            )?
        }
        "chat.send" => {
            let p: ChatSend = parse(params)?;
            chat_send(ctx, p).await?
        }
        "chat.edit" => {
            let p: ChatEdit = parse(params)?;
            chat_edit(ctx, p).await?
        }
        "chat.retry" => {
            let p: ChatRetry = parse(params)?;
            chat_retry(ctx, p).await?
        }
        "chat.cancel" => {
            let p: TaskId = parse(params)?;
            ctx.agents.cancel(&p.task_id);
            json!({})
        }
        "agent.connect" => {
            let p: TaskAgent = parse(params)?;
            let (task, cwd) = locate(ctx, &p.task_id, &p.agent)?;
            ctx.agents.connect(ctx, &task.id, &p.agent, &cwd);
            json!({})
        }
        "agent.disconnect" => {
            let p: AgentId = parse(params)?;
            if !agents::is_known(&p.agent) {
                return Err(RpcError::invalid_params(format!(
                    "unknown agent: {}",
                    p.agent
                )));
            }
            ctx.agents.drop_agent(&p.agent);
            json!({})
        }
        "agent.set_config" => {
            let p: AgentSetConfig = parse(params)?;
            locate(ctx, &p.task_id, &p.agent)?;
            ctx.agents
                .set_config(&p.task_id, &p.agent, &p.config_id, p.value)
                .await
                .map_err(RpcError::failed)?;
            json!({})
        }
        "permission.respond" => {
            let p: PermissionRespond = parse(params)?;
            if !ctx.resolve_permission(&p.request_id, p.option_id) {
                return Err(RpcError::invalid_params("unknown request_id"));
            }
            json!({})
        }
        _ => {
            return Err(RpcError {
                code: -32601,
                message: format!("method not found: {method}"),
            })
        }
    };
    Ok(v)
}

/// The Task and its working directory for a `(task, agent)` request.
fn locate(ctx: &Arc<Ctx>, task_id: &str, agent: &str) -> Result<(Task, String), RpcError> {
    if !agents::is_known(agent) {
        return Err(RpcError::invalid_params(format!("unknown agent: {agent}")));
    }
    task_context(ctx, task_id)
}

/// Shared authority for both agent execution and host file previews.
fn task_context(ctx: &Arc<Ctx>, task_id: &str) -> Result<(Task, String), RpcError> {
    let task = ctx
        .store
        .get_task(task_id)?
        .ok_or_else(|| RpcError::invalid_params("unknown task_id"))?;
    let cwd = match task.project_id.as_deref() {
        Some(project_id) => {
            ctx.store
                .get_project(project_id)?
                .ok_or_else(|| RpcError::invalid_params("task references an unknown project"))?
                .path
        }
        None => ctx.projectless_dir.clone(),
    };
    Ok((task, cwd))
}

#[cfg(test)]
mod file_context_tests {
    use super::*;
    use std::sync::Mutex;

    #[tokio::test]
    async fn preview_context_matches_execution_and_legacy_history_is_enriched_without_rewriting() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let ctx = Arc::new(Ctx {
            store: crate::store::Store::in_memory().unwrap(),
            out: Outbound(tx),
            agents: crate::agents::AgentPool::default(),
            projectless_dir: "/workspace/Application Support/projectless".into(),
            permissions: Mutex::default(),
            elicitations: Mutex::default(),
        });
        let task = ctx.store.create_task(None, "report").unwrap();
        let context = handle(&ctx, "task.context", json!({"task_id":task.id}))
            .await
            .unwrap_or_else(|e| panic!("{}", e.message));
        assert_eq!(
            context["cwd"],
            locate(&ctx, &task.id, "codex")
                .unwrap_or_else(|e| panic!("{}", e.message))
                .1
        );
        assert!(handle(&ctx, "task.context", json!({"task_id":"missing"}))
            .await
            .is_err());
        let project = ctx
            .store
            .create_project("project", "/workspace/project")
            .unwrap();
        let project_task = ctx.store.create_task(Some(&project.id), "report").unwrap();
        assert_eq!(
            task_context(&ctx, &project_task.id)
                .unwrap_or_else(|e| panic!("{}", e.message))
                .1,
            project.path
        );
        let part: Part = serde_json::from_value(json!({"type":"tool_call","id":"write","title":"Write","kind":"edit","status":"completed","_meta":{"claudeCode":{"toolName":"Write"}},"raw_input":{"file_path":"report.md"}})).unwrap();
        ctx.store
            .insert_message(&task.id, "assistant", Some("claude"), &[part], "done")
            .unwrap();
        let history = handle(&ctx, "chat.history", json!({"task_id":task.id}))
            .await
            .unwrap_or_else(|e| panic!("{}", e.message));
        assert_eq!(history[0]["parts"][1]["kind"], "file.output");
        assert_eq!(ctx.store.list_messages(&task.id).unwrap()[0].parts.len(), 1);
    }
}

async fn chat_send(ctx: &Arc<Ctx>, p: ChatSend) -> Result<Value, RpcError> {
    let store = &ctx.store;
    let (task, cwd) = locate(ctx, &p.task_id, &p.agent)?;

    let parts = message_parts(p.text, p.attachments)?;
    let user = store.insert_message(&task.id, "user", Some(&p.agent), &parts, "done")?;
    let assistant =
        store.insert_message(&task.id, "assistant", Some(&p.agent), &[], "streaming")?;
    // The prompt text (handoff + message) is assembled by the agent connection once it
    // knows which session it is talking to; see agents::Connection::build_prompt.
    ctx.agents.send(
        ctx,
        &task.id,
        &p.agent,
        &cwd,
        Job {
            user_message_id: user.id.clone(),
            assistant_message_id: assistant.id.clone(),
        },
    );
    Ok(json!({ "user_message_id": user.id, "assistant_message_id": assistant.id }))
}

/// Edit a user turn by rewinding the transcript to that point and replaying it. The
/// filesystem is deliberately left alone; this is Claude Code's "restore conversation"
/// behavior, not a source-control rollback.
async fn chat_edit(ctx: &Arc<Ctx>, p: ChatEdit) -> Result<Value, RpcError> {
    let store = &ctx.store;
    let (task, cwd) = locate(ctx, &p.task_id, &p.agent)?;
    let transcript = replayable_transcript(store.list_messages(&task.id)?)?;
    let target = transcript
        .iter()
        .find(|m| m.id == p.message_id)
        .ok_or_else(|| RpcError::invalid_params("unknown message_id"))?;
    if target.role != "user" {
        return Err(RpcError::invalid_params(
            "chat.edit requires a user message",
        ));
    }
    let parts = message_parts(p.text, p.attachments)?;

    ctx.agents.drop_task(&task.id);
    if !store.truncate_messages_from(&task.id, &target.id)? {
        return Err(RpcError::invalid_params("unknown message_id"));
    }
    let user = store.insert_message(&task.id, "user", Some(&p.agent), &parts, "done")?;
    let assistant =
        store.insert_message(&task.id, "assistant", Some(&p.agent), &[], "streaming")?;
    ctx.agents.send(
        ctx,
        &task.id,
        &p.agent,
        &cwd,
        Job {
            user_message_id: user.id.clone(),
            assistant_message_id: assistant.id.clone(),
        },
    );
    Ok(json!({ "user_message_id": user.id, "assistant_message_id": assistant.id }))
}

/// Retry a terminal assistant turn without duplicating the user prompt above it.
async fn chat_retry(ctx: &Arc<Ctx>, p: ChatRetry) -> Result<Value, RpcError> {
    let store = &ctx.store;
    let (task, cwd) = locate(ctx, &p.task_id, &p.agent)?;
    let transcript = replayable_transcript(store.list_messages(&task.id)?)?;
    let index = transcript
        .iter()
        .position(|m| m.id == p.message_id)
        .ok_or_else(|| RpcError::invalid_params("unknown message_id"))?;
    let target = &transcript[index];
    if target.role != "assistant" {
        return Err(RpcError::invalid_params(
            "chat.retry requires an assistant message",
        ));
    }
    let user = index
        .checked_sub(1)
        .and_then(|i| transcript.get(i))
        .filter(|m| m.role == "user")
        .ok_or_else(|| RpcError::invalid_params("assistant message has no user prompt"))?;
    let user_message_id = user.id.clone();

    ctx.agents.drop_task(&task.id);
    if !store.truncate_messages_from(&task.id, &target.id)? {
        return Err(RpcError::invalid_params("unknown message_id"));
    }
    let assistant =
        store.insert_message(&task.id, "assistant", Some(&p.agent), &[], "streaming")?;
    ctx.agents.send(
        ctx,
        &task.id,
        &p.agent,
        &cwd,
        Job {
            user_message_id,
            assistant_message_id: assistant.id.clone(),
        },
    );
    Ok(json!({ "assistant_message_id": assistant.id }))
}

fn message_parts(text: String, attachments: Vec<Attachment>) -> Result<Vec<Part>, RpcError> {
    let mut parts = Vec::with_capacity(1 + attachments.len());
    if !text.trim().is_empty() {
        parts.push(Part::Text {
            text,
            meta: None,
            message_id: None,
        });
    }
    parts.extend(attachments.into_iter().map(Attachment::into_part));
    if parts.is_empty() {
        return Err(RpcError::invalid_params("empty message"));
    }
    Ok(parts)
}

fn replayable_transcript(
    messages: Vec<crate::store::Message>,
) -> Result<Vec<crate::store::Message>, RpcError> {
    if messages.iter().any(|m| m.status == "streaming") {
        return Err(RpcError::failed(
            "stop the current response before replaying a turn",
        ));
    }
    Ok(messages)
}
