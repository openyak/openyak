//! ACP agent pool: one adapter process + session per (task, agent), driven lazily.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, InitializeRequest, NewSessionRequest, PermissionOption,
    PromptRequest, RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionNotification, SessionUpdate, StopReason, TextContent,
    ToolCall, ToolCallContent, ToolCallUpdate,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, Agent, Client, ConnectionTo};
use serde::Serialize;
use serde_json::json;
use tokio::sync::{mpsc, oneshot};
use tracing::{info, warn};

use crate::store::{new_id, Part};
use crate::Ctx;

struct Spec {
    id: &'static str,
    name: &'static str,
    /// The user's own CLI; `available` means it is on PATH.
    cli: &'static str,
    /// Adapter binaries to look for on PATH, in order of preference.
    adapters: &'static [&'static str],
    /// npm package to run through `npx` when no adapter binary is installed.
    /// The `@zed-industries/*` packages are deprecated in favour of these.
    package: &'static str,
}

const SPECS: &[Spec] = &[
    Spec {
        id: "claude",
        name: "Claude Code",
        cli: "claude",
        adapters: &["claude-agent-acp", "claude-code-acp"],
        package: "@agentclientprotocol/claude-agent-acp",
    },
    Spec {
        id: "codex",
        name: "Codex",
        cli: "codex",
        adapters: &["codex-acp"],
        package: "@agentclientprotocol/codex-acp",
    },
];

#[derive(Serialize)]
pub struct AgentInfo {
    id: &'static str,
    name: &'static str,
    available: bool,
    command: String,
}

fn spec(id: &str) -> Option<&'static Spec> {
    SPECS.iter().find(|s| s.id == id)
}

pub fn is_known(id: &str) -> bool {
    spec(id).is_some()
}

/// argv for the adapter: the binary on PATH if present, else npx.
fn command(s: &Spec) -> Vec<String> {
    match s.adapters.iter().find_map(|a| which::which(a).ok()) {
        Some(path) => vec![path.to_string_lossy().into_owned()],
        None => vec!["npx".into(), "-y".into(), s.package.into()],
    }
}

pub fn list() -> Vec<AgentInfo> {
    SPECS
        .iter()
        .map(|s| AgentInfo {
            id: s.id,
            name: s.name,
            available: which::which(s.cli).is_ok(),
            command: command(s).join(" "),
        })
        .collect()
}

pub struct Job {
    pub message_id: String,
    pub prompt: String,
}

struct Handle {
    generation: u64,
    task_id: String,
    jobs: mpsc::UnboundedSender<Job>,
    cancel: mpsc::UnboundedSender<()>,
}

#[derive(Default)]
pub struct AgentPool {
    handles: Mutex<HashMap<(String, String), Handle>>,
    next_generation: Mutex<u64>,
}

impl AgentPool {
    /// Queue a prompt for `(task, agent)`, spawning the adapter on first use.
    pub fn send(&self, ctx: &Arc<Ctx>, task_id: &str, agent: &str, cwd: &str, job: Job) {
        let key = (task_id.to_string(), agent.to_string());
        let mut handles = self.handles.lock().unwrap_or_else(|e| e.into_inner());
        let job = match handles.get(&key) {
            Some(h) => match h.jobs.send(job) {
                Ok(()) => return,
                Err(mpsc::error::SendError(job)) => {
                    handles.remove(&key);
                    job
                }
            },
            None => job,
        };
        let generation = {
            let mut g = self
                .next_generation
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            *g += 1;
            *g
        };
        let (jobs_tx, jobs_rx) = mpsc::unbounded_channel();
        let (cancel_tx, cancel_rx) = mpsc::unbounded_channel();
        let _ = jobs_tx.send(job);
        handles.insert(
            key.clone(),
            Handle {
                generation,
                task_id: task_id.to_string(),
                jobs: jobs_tx,
                cancel: cancel_tx,
            },
        );
        drop(handles);

        let conn = Connection {
            ctx: ctx.clone(),
            task_id: task_id.to_string(),
            agent: agent.to_string(),
            cwd: cwd.to_string(),
            live: Arc::default(),
        };
        tokio::spawn(async move {
            conn.run(jobs_rx, cancel_rx).await;
            let ctx = conn.ctx.clone();
            let mut handles = ctx.agents.handles.lock().unwrap_or_else(|e| e.into_inner());
            if handles
                .get(&key)
                .is_some_and(|h| h.generation == generation)
            {
                handles.remove(&key);
            }
        });
    }

    /// Cancel any in-flight prompt for the task, on every agent serving it.
    pub fn cancel(&self, task_id: &str) {
        let handles = self.handles.lock().unwrap_or_else(|e| e.into_inner());
        for h in handles.values().filter(|h| h.task_id == task_id) {
            let _ = h.cancel.send(());
        }
    }
}

/// The streaming assistant Message for the prompt currently in flight.
struct Live {
    message_id: String,
    parts: Vec<Part>,
    tools: HashMap<String, usize>,
    cancelled: bool,
}

#[derive(Clone)]
struct Connection {
    ctx: Arc<Ctx>,
    task_id: String,
    agent: String,
    cwd: String,
    live: Arc<Mutex<Option<Live>>>,
}

impl Connection {
    fn status(&self, state: &str, detail: Option<String>) {
        let mut params = json!({ "task_id": self.task_id, "agent": self.agent, "state": state });
        if let Some(d) = detail {
            params["detail"] = json!(d);
        }
        self.ctx.out.notify("agent.status", params);
    }

    async fn run(
        &self,
        mut jobs_rx: mpsc::UnboundedReceiver<Job>,
        mut cancel_rx: mpsc::UnboundedReceiver<()>,
    ) {
        let argv = command(spec(&self.agent).expect("agent validated by caller"));
        info!(agent = %self.agent, task = %self.task_id, command = ?argv, "starting agent");
        self.status("starting", None);

        let result = match AcpAgent::from_args(argv) {
            Ok(adapter) => {
                let adapter = adapter.with_debug(|line, dir| tracing::debug!(?dir, "{line}"));
                let jobs = &mut jobs_rx;
                let cancels = &mut cancel_rx;
                let updates = self.clone();
                let perms = self.clone();
                Client
                    .builder()
                    .on_receive_notification(
                        async move |n: SessionNotification, _cx| {
                            updates.on_update(n.update);
                            Ok(())
                        },
                        agent_client_protocol::on_receive_notification!(),
                    )
                    .on_receive_request(
                        async move |req: RequestPermissionRequest, responder, _cx| {
                            perms.on_permission(req, responder);
                            Ok(())
                        },
                        agent_client_protocol::on_receive_request!(),
                    )
                    .connect_with(adapter, async move |connection: ConnectionTo<Agent>| {
                        self.serve(connection, jobs, cancels).await
                    })
                    .await
            }
            Err(e) => Err(e),
        };

        let detail = result.err().map(|e| error_text(&e));
        if let Some(d) = &detail {
            warn!(agent = %self.agent, task = %self.task_id, "agent exited: {d}");
        }
        // A prompt in flight or still queued can no longer be served.
        let reason = detail.clone().unwrap_or_else(|| "agent exited".to_string());
        if let Some(live) = self.live.lock().unwrap_or_else(|e| e.into_inner()).take() {
            self.finish(live, Err(reason.clone()));
        }
        jobs_rx.close();
        while let Ok(job) = jobs_rx.try_recv() {
            self.finish(Live::new(job.message_id), Err(reason.clone()));
        }
        self.status("exited", detail);
    }

    async fn serve(
        &self,
        connection: ConnectionTo<Agent>,
        jobs: &mut mpsc::UnboundedReceiver<Job>,
        cancels: &mut mpsc::UnboundedReceiver<()>,
    ) -> Result<(), agent_client_protocol::Error> {
        connection
            .send_request(InitializeRequest::new(ProtocolVersion::V1))
            .block_task()
            .await?;
        let session_id = connection
            .send_request(NewSessionRequest::new(self.cwd.clone()))
            .block_task()
            .await?
            .session_id;
        info!(agent = %self.agent, task = %self.task_id, "session ready");
        self.status("ready", None);

        while let Some(job) = jobs.recv().await {
            while cancels.try_recv().is_ok() {}
            *self.live.lock().unwrap_or_else(|e| e.into_inner()) = Some(Live::new(job.message_id));

            let prompt = connection
                .send_request(PromptRequest::new(
                    session_id.clone(),
                    vec![ContentBlock::Text(TextContent::new(job.prompt))],
                ))
                .block_task();
            tokio::pin!(prompt);
            let outcome = loop {
                tokio::select! {
                    r = &mut prompt => break r,
                    Some(()) = cancels.recv() => {
                        info!(agent = %self.agent, task = %self.task_id, "cancelling prompt");
                        if let Some(l) = self.live.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
                            l.cancelled = true;
                        }
                        connection.send_notification(CancelNotification::new(session_id.clone()))?;
                    }
                }
            };
            let Some(live) = self.live.lock().unwrap_or_else(|e| e.into_inner()).take() else {
                continue;
            };
            match outcome {
                Ok(resp) => {
                    let cancelled = live.cancelled || resp.stop_reason == StopReason::Cancelled;
                    self.finish(live, Ok(cancelled));
                }
                Err(e) => {
                    let text = error_text(&e);
                    self.finish(live, Err(text));
                    return Err(e);
                }
            }
        }
        Ok(())
    }

    /// Persist the assistant Message, advance the cursor past it, and emit `chat.done`.
    /// `outcome` is `Ok(cancelled)` or `Err(error text)`.
    fn finish(&self, mut live: Live, outcome: Result<bool, String>) {
        let (status, error) = match outcome {
            Ok(false) => ("done", None),
            Ok(true) => ("cancelled", None),
            Err(e) => {
                let index = live.parts.len();
                live.parts.push(Part::Error { message: e.clone() });
                self.emit(&live.message_id, index, &live.parts[index]);
                ("error", Some(e))
            }
        };
        let store = &self.ctx.store;
        if let Err(e) = store.finish_message(&live.message_id, &live.parts, status) {
            warn!("persist assistant message: {e:#}");
        }
        match store.list_messages(&self.task_id) {
            Ok(transcript) => {
                if let Some(index) = transcript.iter().position(|m| m.id == live.message_id) {
                    let seen = store.cursor(&self.task_id, &self.agent).unwrap_or(-1);
                    if index as i64 > seen {
                        if let Err(e) = store.set_cursor(&self.task_id, &self.agent, index as i64) {
                            warn!("advance cursor: {e:#}");
                        }
                    }
                }
            }
            Err(e) => warn!("reload transcript: {e:#}"),
        }
        let mut params =
            json!({ "task_id": self.task_id, "message_id": live.message_id, "status": status });
        if let Some(e) = error {
            params["error"] = json!(e);
        }
        self.ctx.out.notify("chat.done", params);
    }

    fn emit(&self, message_id: &str, index: usize, part: &Part) {
        self.ctx.out.notify(
            "chat.update",
            json!({ "task_id": self.task_id, "message_id": message_id, "part_index": index, "part": part }),
        );
    }

    fn on_update(&self, update: SessionUpdate) {
        let mut guard = self.live.lock().unwrap_or_else(|e| e.into_inner());
        let Some(live) = guard.as_mut() else {
            return;
        };
        if let Some(index) = live.apply(update) {
            self.emit(&live.message_id, index, &live.parts[index]);
        }
    }

    fn on_permission(
        &self,
        req: RequestPermissionRequest,
        responder: agent_client_protocol::Responder<RequestPermissionResponse>,
    ) {
        let request_id = new_id();
        let (tx, rx) = oneshot::channel();
        self.ctx.register_permission(request_id.clone(), tx);
        let title = req
            .tool_call
            .fields
            .title
            .clone()
            .unwrap_or_else(|| req.tool_call.tool_call_id.0.to_string());
        let options: Vec<_> = req.options.iter().map(option_json).collect();
        self.ctx.out.request(
            &request_id,
            "permission.request",
            json!({
                "request_id": request_id,
                "task_id": self.task_id,
                "agent": self.agent,
                "title": title,
                "options": options,
            }),
        );
        let ctx = self.ctx.clone();
        tokio::spawn(async move {
            let answer = rx.await.ok().flatten();
            ctx.forget_permission(&request_id);
            let outcome = match answer {
                Some(option_id) => {
                    RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                        agent_client_protocol::schema::v1::PermissionOptionId::new(option_id),
                    ))
                }
                None => RequestPermissionOutcome::Cancelled,
            };
            if let Err(e) = responder.respond(RequestPermissionResponse::new(outcome)) {
                warn!("permission response: {}", error_text(&e));
            }
        });
    }
}

fn option_json(o: &PermissionOption) -> serde_json::Value {
    json!({ "id": o.option_id.0, "label": o.name, "kind": enum_str(&o.kind) })
}

fn enum_str<T: Serialize>(v: &T) -> String {
    match serde_json::to_value(v) {
        Ok(serde_json::Value::String(s)) => s,
        Ok(other) => other.to_string(),
        Err(_) => String::new(),
    }
}

pub fn error_text(e: &agent_client_protocol::Error) -> String {
    match &e.data {
        Some(d) => format!("{} ({d})", e.message),
        None => e.message.clone(),
    }
}

fn chunk_text(block: ContentBlock) -> Option<String> {
    match block {
        ContentBlock::Text(t) => Some(t.text),
        _ => None,
    }
}

fn tool_output(content: &[ToolCallContent]) -> Option<String> {
    let lines: Vec<String> = content
        .iter()
        .filter_map(|c| match c {
            ToolCallContent::Content(c) => match &c.content {
                ContentBlock::Text(t) => Some(t.text.clone()),
                _ => None,
            },
            ToolCallContent::Diff(d) => Some(format!("diff {}", d.path.display())),
            _ => None,
        })
        .collect();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

impl Live {
    fn new(message_id: String) -> Self {
        Self {
            message_id,
            parts: Vec::new(),
            tools: HashMap::new(),
            cancelled: false,
        }
    }

    /// Fold one ACP update into the parts; returns the index of the part that changed.
    fn apply(&mut self, update: SessionUpdate) -> Option<usize> {
        match update {
            SessionUpdate::AgentMessageChunk(c) => {
                let text = chunk_text(c.content).filter(|t| !t.is_empty())?;
                Some(self.append_text(text, false))
            }
            SessionUpdate::AgentThoughtChunk(c) => {
                let text = chunk_text(c.content).filter(|t| !t.is_empty())?;
                Some(self.append_text(text, true))
            }
            SessionUpdate::ToolCall(tc) => Some(self.tool_call(tc)),
            SessionUpdate::ToolCallUpdate(u) => Some(self.tool_call_update(u)),
            _ => None,
        }
    }

    fn append_text(&mut self, delta: String, thought: bool) -> usize {
        if let Some(last) = self.parts.last_mut() {
            match (last, thought) {
                (Part::Text { text }, false) | (Part::Thought { text }, true) => {
                    text.push_str(&delta);
                    return self.parts.len() - 1;
                }
                _ => {}
            }
        }
        self.parts.push(if thought {
            Part::Thought { text: delta }
        } else {
            Part::Text { text: delta }
        });
        self.parts.len() - 1
    }

    fn tool_call(&mut self, tc: ToolCall) -> usize {
        let id = tc.tool_call_id.0.to_string();
        let part = Part::ToolCall {
            id: id.clone(),
            title: tc.title,
            kind: enum_str(&tc.kind),
            status: enum_str(&tc.status),
            output: tool_output(&tc.content),
        };
        match self.tools.get(&id) {
            Some(&i) => {
                self.parts[i] = part;
                i
            }
            None => {
                self.parts.push(part);
                let i = self.parts.len() - 1;
                self.tools.insert(id, i);
                i
            }
        }
    }

    fn tool_call_update(&mut self, u: ToolCallUpdate) -> usize {
        let id = u.tool_call_id.0.to_string();
        let index = match self.tools.get(&id) {
            Some(&i) => i,
            None => {
                self.parts.push(Part::ToolCall {
                    id: id.clone(),
                    title: id.clone(),
                    kind: "other".into(),
                    status: "pending".into(),
                    output: None,
                });
                let i = self.parts.len() - 1;
                self.tools.insert(id, i);
                i
            }
        };
        if let Part::ToolCall {
            title,
            kind,
            status,
            output,
            ..
        } = &mut self.parts[index]
        {
            let f = u.fields;
            if let Some(t) = f.title {
                *title = t;
            }
            if let Some(k) = f.kind {
                *kind = enum_str(&k);
            }
            if let Some(s) = f.status {
                *status = enum_str(&s);
            }
            if let Some(o) = f.content.as_deref().and_then(tool_output) {
                *output = Some(o);
            }
        }
        index
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{
        ContentChunk, ToolCallStatus, ToolCallUpdateFields, ToolKind,
    };

    fn chunk(s: &str) -> ContentChunk {
        ContentChunk::new(ContentBlock::Text(TextContent::new(s)))
    }

    #[test]
    fn text_chunks_accumulate_into_one_part() {
        let mut live = Live::new("m".into());
        assert_eq!(
            live.apply(SessionUpdate::AgentMessageChunk(chunk("PO"))),
            Some(0)
        );
        assert_eq!(
            live.apply(SessionUpdate::AgentMessageChunk(chunk("NG"))),
            Some(0)
        );
        assert_eq!(
            live.parts,
            vec![Part::Text {
                text: "PONG".into()
            }]
        );
        assert_eq!(
            live.apply(SessionUpdate::AgentThoughtChunk(chunk("t"))),
            Some(1)
        );
        assert_eq!(
            live.apply(SessionUpdate::AgentMessageChunk(chunk("!"))),
            Some(2)
        );
    }

    #[test]
    fn tool_calls_update_in_place() {
        let mut live = Live::new("m".into());
        live.apply(SessionUpdate::AgentMessageChunk(chunk("x")));
        let tc = ToolCall::new("tc1", "ls").kind(ToolKind::Execute);
        assert_eq!(live.apply(SessionUpdate::ToolCall(tc)), Some(1));
        let upd = ToolCallUpdate::new(
            "tc1",
            ToolCallUpdateFields::new()
                .status(ToolCallStatus::Completed)
                .content(vec![ToolCallContent::from(ContentBlock::Text(
                    TextContent::new("a\nb"),
                ))]),
        );
        assert_eq!(live.apply(SessionUpdate::ToolCallUpdate(upd)), Some(1));
        assert_eq!(
            live.parts[1],
            Part::ToolCall {
                id: "tc1".into(),
                title: "ls".into(),
                kind: "execute".into(),
                status: "completed".into(),
                output: Some("a\nb".into()),
            }
        );
    }
}
