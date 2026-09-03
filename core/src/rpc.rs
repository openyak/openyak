//! JSON-RPC 2.0 over stdio: outbound line writer and request dispatch (docs/core-protocol.md).

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::agents::{self, Job};
use crate::store::{Part, Project, Task};
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
struct TaskId {
    task_id: String,
}
#[derive(Deserialize)]
struct ProjectCreate {
    name: String,
    path: String,
}
#[derive(Deserialize)]
struct TaskCreate {
    project_id: String,
    title: String,
}
#[derive(Deserialize)]
struct TaskAgent {
    task_id: String,
    agent: String,
}
#[derive(Deserialize)]
struct ChatSend {
    task_id: String,
    agent: String,
    text: String,
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
        "agent.list" => json!(agents::list()),
        "project.list" => json!(store.list_projects()?),
        "project.create" => {
            let p: ProjectCreate = parse(params)?;
            json!(store.create_project(&p.name, &p.path)?)
        }
        "task.list" => {
            let p: ProjectId = parse(params)?;
            json!(store.list_tasks(&p.project_id)?)
        }
        "task.create" => {
            let p: TaskCreate = parse(params)?;
            if store.get_project(&p.project_id)?.is_none() {
                return Err(RpcError::invalid_params("unknown project_id"));
            }
            json!(store.create_task(&p.project_id, &p.title)?)
        }
        "chat.history" => {
            let p: TaskId = parse(params)?;
            json!(store.list_messages(&p.task_id)?)
        }
        "chat.send" => {
            let p: ChatSend = parse(params)?;
            chat_send(ctx, p).await?
        }
        "chat.cancel" => {
            let p: TaskId = parse(params)?;
            ctx.agents.cancel(&p.task_id);
            json!({})
        }
        "agent.connect" => {
            let p: TaskAgent = parse(params)?;
            let (task, project) = locate(ctx, &p.task_id, &p.agent)?;
            ctx.agents.connect(ctx, &task.id, &p.agent, &project.path);
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

/// The Task and its Project for a `(task, agent)` request, after validating the agent id.
fn locate(ctx: &Arc<Ctx>, task_id: &str, agent: &str) -> Result<(Task, Project), RpcError> {
    if !agents::is_known(agent) {
        return Err(RpcError::invalid_params(format!("unknown agent: {agent}")));
    }
    let task = ctx
        .store
        .get_task(task_id)?
        .ok_or_else(|| RpcError::invalid_params("unknown task_id"))?;
    let project = ctx
        .store
        .get_project(&task.project_id)?
        .ok_or_else(|| RpcError::invalid_params("task has no project"))?;
    Ok((task, project))
}

async fn chat_send(ctx: &Arc<Ctx>, p: ChatSend) -> Result<Value, RpcError> {
    let store = &ctx.store;
    let (task, project) = locate(ctx, &p.task_id, &p.agent)?;

    let user = store.insert_message(
        &task.id,
        "user",
        Some(&p.agent),
        &[Part::Text { text: p.text }],
        "done",
    )?;
    let assistant =
        store.insert_message(&task.id, "assistant", Some(&p.agent), &[], "streaming")?;
    // The prompt text (handoff + message) is assembled by the agent connection once it
    // knows which session it is talking to; see agents::Connection::build_prompt.
    ctx.agents.send(
        ctx,
        &task.id,
        &p.agent,
        &project.path,
        Job {
            user_message_id: user.id.clone(),
            assistant_message_id: assistant.id.clone(),
        },
    );
    Ok(json!({ "user_message_id": user.id, "assistant_message_id": assistant.id }))
}
