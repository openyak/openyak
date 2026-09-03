//! ACP agent pool: one adapter process + session per (task, agent), driven lazily.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, ImageContent, InitializeRequest, LoadSessionRequest,
    NewSessionRequest, PermissionOption, PromptRequest, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, ResourceLink, SelectedPermissionOutcome,
    SessionConfigId, SessionConfigKind, SessionConfigOption, SessionConfigOptionCategory,
    SessionConfigOptionValue, SessionConfigSelectOption, SessionConfigSelectOptions,
    SessionConfigValueId, SessionId, SessionModeId, SessionModeState, SessionNotification,
    SessionUpdate, SetSessionConfigOptionRequest, SetSessionModeRequest, StopReason, TextContent,
    ToolCall, ToolCallContent, ToolCallUpdate,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, Agent, Client, ConnectionTo};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use tracing::{info, warn};

use crate::handoff;
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

/// A prompt to serve: the user Message to send and the assistant Message to stream into.
pub struct Job {
    pub user_message_id: String,
    pub assistant_message_id: String,
}

enum Command {
    Prompt(Job),
    SetConfig {
        config_id: String,
        value: Value,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Re-send `agent.status` and `agent.config` for a session that is already up, so a
    /// renderer that (re)loaded after the session started still learns its options.
    Announce,
}

struct Handle {
    generation: u64,
    task_id: String,
    commands: mpsc::UnboundedSender<Command>,
    cancel: mpsc::UnboundedSender<()>,
}

#[derive(Default)]
pub struct AgentPool {
    handles: Mutex<HashMap<(String, String), Handle>>,
    next_generation: Mutex<u64>,
}

/// How long a config change may take before the app is told the agent did not answer.
const SET_CONFIG_TIMEOUT: Duration = Duration::from_secs(30);
const SET_CONFIG_TIMED_OUT: &str = "agent did not answer in time";

impl AgentPool {
    /// The command channel for `(task, agent)`, spawning the adapter on first use or after
    /// the previous one exited. The flag says whether this call spawned it.
    fn ensure(
        &self,
        ctx: &Arc<Ctx>,
        task_id: &str,
        agent: &str,
        cwd: &str,
    ) -> (mpsc::UnboundedSender<Command>, bool) {
        let key = (task_id.to_string(), agent.to_string());
        let mut handles = self.handles.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(h) = handles.get(&key) {
            if !h.commands.is_closed() {
                return (h.commands.clone(), false);
            }
            handles.remove(&key);
        }
        let generation = {
            let mut g = self
                .next_generation
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            *g += 1;
            *g
        };
        let (commands_tx, commands_rx) = mpsc::unbounded_channel();
        let (cancel_tx, cancel_rx) = mpsc::unbounded_channel();
        handles.insert(
            key.clone(),
            Handle {
                generation,
                task_id: task_id.to_string(),
                commands: commands_tx.clone(),
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
            options: Arc::default(),
        };
        tokio::spawn(async move {
            conn.run(commands_rx, cancel_rx).await;
            let ctx = conn.ctx.clone();
            let mut handles = ctx.agents.handles.lock().unwrap_or_else(|e| e.into_inner());
            if handles
                .get(&key)
                .is_some_and(|h| h.generation == generation)
            {
                handles.remove(&key);
            }
        });
        (commands_tx, true)
    }

    /// Start the adapter and session for `(task, agent)` unless already running, so the
    /// agent's config options are known before the first prompt. A running session is
    /// asked to announce its status and options again.
    pub fn connect(&self, ctx: &Arc<Ctx>, task_id: &str, agent: &str, cwd: &str) {
        let (commands, spawned) = self.ensure(ctx, task_id, agent, cwd);
        if !spawned {
            let _ = commands.send(Command::Announce);
        }
    }

    /// Queue a prompt for `(task, agent)`.
    pub fn send(&self, ctx: &Arc<Ctx>, task_id: &str, agent: &str, cwd: &str, job: Job) {
        let job = match send_prompt(&self.ensure(ctx, task_id, agent, cwd).0, job) {
            Ok(()) => return,
            // The adapter exited between ensure() and here; once more with a fresh one.
            Err(job) => job,
        };
        if let Err(job) = send_prompt(&self.ensure(ctx, task_id, agent, cwd).0, job) {
            finish_message(
                ctx,
                task_id,
                agent,
                Live::new(job.assistant_message_id),
                Err("agent exited".into()),
            );
        }
    }

    /// Change one session config option on the running adapter for `(task, agent)`.
    pub async fn set_config(
        &self,
        task_id: &str,
        agent: &str,
        config_id: &str,
        value: Value,
    ) -> Result<(), String> {
        let key = (task_id.to_string(), agent.to_string());
        let commands = self
            .handles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&key)
            .filter(|h| !h.commands.is_closed())
            .map(|h| h.commands.clone());
        let Some(commands) = commands else {
            return Err("agent is not connected".into());
        };
        let (reply, answer) = oneshot::channel();
        commands
            .send(Command::SetConfig {
                config_id: config_id.to_string(),
                value,
                reply,
            })
            .map_err(|_| "agent exited".to_string())?;
        match tokio::time::timeout(SET_CONFIG_TIMEOUT, answer).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("agent exited".into()),
            Err(_) => Err(SET_CONFIG_TIMED_OUT.into()),
        }
    }

    /// Forget every connection serving the task. Dropping the handles closes their
    /// command channels, so each connection finishes what is in flight and exits.
    pub fn drop_task(&self, task_id: &str) {
        let mut handles = self.handles.lock().unwrap_or_else(|e| e.into_inner());
        for h in handles.values().filter(|h| h.task_id == task_id) {
            let _ = h.cancel.send(());
        }
        handles.retain(|_, h| h.task_id != task_id);
    }

    /// Cancel any in-flight prompt for the task, on every agent serving it.
    pub fn cancel(&self, task_id: &str) {
        let handles = self.handles.lock().unwrap_or_else(|e| e.into_inner());
        for h in handles.values().filter(|h| h.task_id == task_id) {
            let _ = h.cancel.send(());
        }
    }
}

fn send_prompt(commands: &mpsc::UnboundedSender<Command>, job: Job) -> Result<(), Job> {
    match commands.send(Command::Prompt(job)) {
        Ok(()) => Ok(()),
        Err(mpsc::error::SendError(Command::Prompt(job))) => Err(job),
        Err(_) => unreachable!("only prompts are sent here"),
    }
}

/// The streaming assistant Message for the prompt currently in flight.
struct Live {
    message_id: String,
    parts: Vec<Part>,
    tools: HashMap<String, usize>,
    cancelled: bool,
}

/// Id of the synthesized option for agents that only speak the older modes API.
const MODE_OPTION_ID: &str = "mode";

/// What the agent advertises for its session: config options (model, effort, mode…) and,
/// for agents that only speak the older modes API, the mode list.
#[derive(Default)]
struct Options {
    config: Vec<SessionConfigOption>,
    modes: Option<SessionModeState>,
}

impl Options {
    fn set(&mut self, config: Option<Vec<SessionConfigOption>>, modes: Option<SessionModeState>) {
        self.config = config.unwrap_or_default();
        self.modes = modes;
    }

    /// True when `config_id` must go through `session/set_mode`: the agent lists modes but
    /// no config option for them.
    fn is_mode_only(&self, config_id: &str) -> bool {
        config_id == MODE_OPTION_ID
            && self.modes.is_some()
            && !self.config.iter().any(|c| &*c.id.0 == config_id)
    }

    fn set_mode(&mut self, mode_id: &SessionModeId) {
        if let Some(m) = &mut self.modes {
            m.current_mode_id = mode_id.clone();
        }
        for c in &mut self.config {
            if matches!(c.category, Some(SessionConfigOptionCategory::Mode)) {
                if let SessionConfigKind::Select(s) = &mut c.kind {
                    s.current_value = SessionConfigValueId::new(mode_id.0.clone());
                }
            }
        }
    }

    /// The options as the app sees them (`agent.config` in docs/core-protocol.md).
    fn to_json(&self) -> Vec<Value> {
        if !self.config.is_empty() {
            return self.config.iter().map(config_option_json).collect();
        }
        let Some(m) = &self.modes else {
            return vec![];
        };
        let options: Vec<Value> = m
            .available_modes
            .iter()
            .map(|x| {
                let mut v = json!({ "value": &*x.id.0, "name": x.name });
                if let Some(d) = &x.description {
                    v["description"] = json!(d);
                }
                v
            })
            .collect();
        vec![json!({
            "id": MODE_OPTION_ID,
            "name": "Mode",
            "category": "mode",
            "type": "select",
            "current_value": &*m.current_mode_id.0,
            "options": options,
        })]
    }
}

fn config_option_json(o: &SessionConfigOption) -> Value {
    let mut v = json!({ "id": &*o.id.0, "name": o.name });
    if let Some(d) = &o.description {
        v["description"] = json!(d);
    }
    if let Some(c) = &o.category {
        v["category"] = json!(enum_str(c));
    }
    match &o.kind {
        SessionConfigKind::Select(s) => {
            v["type"] = json!("select");
            v["current_value"] = json!(&*s.current_value.0);
            let options: Vec<Value> = match &s.options {
                SessionConfigSelectOptions::Ungrouped(list) => {
                    list.iter().map(|x| select_option_json(x, None)).collect()
                }
                SessionConfigSelectOptions::Grouped(groups) => groups
                    .iter()
                    .flat_map(|g| {
                        g.options
                            .iter()
                            .map(|x| select_option_json(x, Some(&g.name)))
                    })
                    .collect(),
                _ => vec![],
            };
            v["options"] = json!(options);
        }
        SessionConfigKind::Boolean(b) => {
            v["type"] = json!("boolean");
            v["current_value"] = json!(b.current_value);
        }
        _ => {
            v["type"] = json!("unknown");
        }
    }
    v
}

fn select_option_json(o: &SessionConfigSelectOption, group: Option<&str>) -> Value {
    let mut v = json!({ "value": &*o.value.0, "name": o.name });
    if let Some(d) = &o.description {
        v["description"] = json!(d);
    }
    if let Some(g) = group {
        v["group"] = json!(g);
    }
    // Agents tag modes with a kind (standard, auto_review, full_access, plan, …) in
    // `_meta`; the app uses it only for the icon and colour of the mode pill.
    if let Some(kind) = o
        .meta
        .as_ref()
        .and_then(|m| m.get("kind"))
        .and_then(Value::as_str)
    {
        v["kind"] = json!(kind);
    }
    v
}

#[derive(Clone)]
struct Connection {
    ctx: Arc<Ctx>,
    task_id: String,
    agent: String,
    cwd: String,
    live: Arc<Mutex<Option<Live>>>,
    options: Arc<Mutex<Options>>,
}

type AcpResult<T> = Result<T, agent_client_protocol::Error>;

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
        mut commands: mpsc::UnboundedReceiver<Command>,
        mut cancels: mpsc::UnboundedReceiver<()>,
    ) {
        let argv = command(spec(&self.agent).expect("agent validated by caller"));
        info!(agent = %self.agent, task = %self.task_id, command = ?argv, "starting agent");
        self.status("starting", None);

        let result = match AcpAgent::from_args(argv) {
            Ok(adapter) => {
                let adapter = adapter.with_debug(|line, dir| tracing::debug!(?dir, "{line}"));
                let commands = &mut commands;
                let cancels = &mut cancels;
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
                        self.serve(connection, commands, cancels).await
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
        commands.close();
        while let Ok(cmd) = commands.try_recv() {
            match cmd {
                Command::Prompt(job) => {
                    self.finish(Live::new(job.assistant_message_id), Err(reason.clone()))
                }
                Command::SetConfig { reply, .. } => {
                    let _ = reply.send(Err(reason.clone()));
                }
                Command::Announce => {}
            }
        }
        self.status("exited", detail);
    }

    async fn serve(
        &self,
        connection: ConnectionTo<Agent>,
        commands: &mut mpsc::UnboundedReceiver<Command>,
        cancels: &mut mpsc::UnboundedReceiver<()>,
    ) -> AcpResult<()> {
        let init = connection
            .send_request(InitializeRequest::new(ProtocolVersion::V1))
            .block_task()
            .await?;
        let session_id = self
            .open_session(&connection, init.agent_capabilities.load_session)
            .await?;
        info!(agent = %self.agent, task = %self.task_id, "session ready");
        self.status("ready", None);

        // Prompts that arrived while another was in flight; served in order.
        let mut queued: VecDeque<Job> = VecDeque::new();
        loop {
            let job = match queued.pop_front() {
                Some(job) => job,
                None => match commands.recv().await {
                    None => return Ok(()),
                    Some(Command::Prompt(job)) => job,
                    Some(Command::SetConfig {
                        config_id,
                        value,
                        reply,
                    }) => {
                        let _ = reply.send(
                            self.apply_config(&connection, &session_id, &config_id, &value)
                                .await,
                        );
                        continue;
                    }
                    Some(Command::Announce) => {
                        self.status("ready", None);
                        self.emit_config();
                        continue;
                    }
                },
            };
            self.prompt(
                &connection,
                &session_id,
                job,
                commands,
                cancels,
                &mut queued,
            )
            .await?;
        }
    }

    /// Resume the session recorded for `(task, agent)` when the agent supports it, else
    /// start a fresh one. Either way the agent's config options end up announced.
    async fn open_session(
        &self,
        connection: &ConnectionTo<Agent>,
        can_load: bool,
    ) -> AcpResult<SessionId> {
        let store = &self.ctx.store;
        let saved = store
            .session_id(&self.task_id, &self.agent)
            .unwrap_or_else(|e| {
                warn!("read session id: {e:#}");
                None
            });
        if let (true, Some(saved)) = (can_load, saved) {
            let load = LoadSessionRequest::new(SessionId::new(saved.clone()), self.cwd.clone());
            match connection.send_request(load).block_task().await {
                Ok(resp) => {
                    info!(agent = %self.agent, task = %self.task_id, "resumed session");
                    self.lock_options().set(resp.config_options, resp.modes);
                    if let Err(e) = store.begin_session(&self.task_id, &self.agent, &saved, false) {
                        warn!("record session: {e:#}");
                    }
                    // A resumed session brings its thread back, but not necessarily the
                    // options that were set on the previous process (Codex reports its
                    // defaults again), so the user's choices are re-applied here too.
                    let session_id = SessionId::new(saved);
                    self.reapply_config(connection, &session_id).await;
                    self.emit_config();
                    return Ok(session_id);
                }
                Err(e) => warn!(
                    agent = %self.agent, task = %self.task_id,
                    "session/load failed, starting fresh: {}", error_text(&e)
                ),
            }
        }
        let resp = connection
            .send_request(NewSessionRequest::new(self.cwd.clone()))
            .block_task()
            .await?;
        let session_id = resp.session_id.clone();
        // A fresh session has no memory of the Chat: reset the cursor so the next prompt
        // carries the whole thread as a handoff.
        if let Err(e) = store.begin_session(&self.task_id, &self.agent, &session_id.0, true) {
            warn!("record session: {e:#}");
        }
        self.lock_options().set(resp.config_options, resp.modes);
        self.reapply_config(connection, &session_id).await;
        self.emit_config();
        Ok(session_id)
    }

    /// Re-apply the values the user picked earlier for this `(task, agent)` to a fresh
    /// session. Anything the agent no longer accepts is logged and skipped.
    async fn reapply_config(&self, connection: &ConnectionTo<Agent>, session_id: &SessionId) {
        let values = match self.ctx.store.config_values(&self.task_id, &self.agent) {
            Ok(v) => v,
            Err(e) => {
                warn!("read config values: {e:#}");
                return;
            }
        };
        for (config_id, value) in values {
            if let Err(e) = self
                .apply_config(connection, session_id, &config_id, &value)
                .await
            {
                warn!(agent = %self.agent, task = %self.task_id, config_id, "re-apply config: {e}");
            }
        }
    }

    /// Set one config option (or mode) on the session, remember the choice, and announce
    /// the agent's updated options.
    async fn apply_config(
        &self,
        connection: &ConnectionTo<Agent>,
        session_id: &SessionId,
        config_id: &str,
        value: &Value,
    ) -> Result<(), String> {
        let mode_only = self.lock_options().is_mode_only(config_id);
        let request = async {
            if mode_only {
                let Some(mode) = value.as_str() else {
                    return Err("mode must be a string".to_string());
                };
                let mode = SessionModeId::new(mode);
                connection
                    .send_request(SetSessionModeRequest::new(session_id.clone(), mode.clone()))
                    .block_task()
                    .await
                    .map_err(|e| error_text(&e))?;
                self.lock_options().set_mode(&mode);
            } else {
                let acp_value = match value {
                    Value::Bool(b) => SessionConfigOptionValue::Boolean { value: *b },
                    Value::String(s) => SessionConfigOptionValue::ValueId {
                        value: SessionConfigValueId::new(s.as_str()),
                    },
                    _ => return Err("value must be a string or a boolean".to_string()),
                };
                let resp = connection
                    .send_request(SetSessionConfigOptionRequest::new(
                        session_id.clone(),
                        SessionConfigId::new(config_id),
                        acp_value,
                    ))
                    .block_task()
                    .await
                    .map_err(|e| error_text(&e))?;
                self.lock_options().config = resp.config_options;
            }
            Ok(())
        };
        tokio::time::timeout(SET_CONFIG_TIMEOUT, request)
            .await
            .unwrap_or_else(|_| Err(SET_CONFIG_TIMED_OUT.to_string()))?;
        if let Err(e) =
            self.ctx
                .store
                .set_config_value(&self.task_id, &self.agent, config_id, value)
        {
            warn!("persist config value: {e:#}");
        }
        self.emit_config();
        Ok(())
    }

    /// Send one prompt and stream its reply, serving cancels and config changes meanwhile.
    async fn prompt(
        &self,
        connection: &ConnectionTo<Agent>,
        session_id: &SessionId,
        job: Job,
        commands: &mut mpsc::UnboundedReceiver<Command>,
        cancels: &mut mpsc::UnboundedReceiver<()>,
        queued: &mut VecDeque<Job>,
    ) -> AcpResult<()> {
        while cancels.try_recv().is_ok() {}
        let blocks = match self.build_prompt(&job) {
            Ok(blocks) => blocks,
            Err(e) => {
                self.finish(Live::new(job.assistant_message_id), Err(e));
                return Ok(());
            }
        };
        *self.live.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(Live::new(job.assistant_message_id));

        let request = connection
            .send_request(PromptRequest::new(session_id.clone(), blocks))
            .block_task();
        tokio::pin!(request);
        let outcome = loop {
            tokio::select! {
                r = &mut request => break r,
                Some(()) = cancels.recv() => {
                    info!(agent = %self.agent, task = %self.task_id, "cancelling prompt");
                    if let Some(l) = self.live.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
                        l.cancelled = true;
                    }
                    connection.send_notification(CancelNotification::new(session_id.clone()))?;
                }
                Some(cmd) = commands.recv() => match cmd {
                    Command::Prompt(next) => queued.push_back(next),
                    Command::SetConfig { config_id, value, reply } => {
                        let _ = reply.send(
                            self.apply_config(connection, session_id, &config_id, &value).await,
                        );
                    }
                    Command::Announce => {
                        self.status("ready", None);
                        self.emit_config();
                    }
                },
            }
        };
        let Some(live) = self.live.lock().unwrap_or_else(|e| e.into_inner()).take() else {
            return Ok(());
        };
        match outcome {
            Ok(resp) => {
                let cancelled = live.cancelled || resp.stop_reason == StopReason::Cancelled;
                self.finish(live, Ok(cancelled));
                Ok(())
            }
            Err(e) => {
                self.finish(live, Err(error_text(&e)));
                Err(e)
            }
        }
    }

    /// The prompt text for a Job: handoff of what this agent has not seen, then the user's
    /// message. Assembled here rather than at `chat.send` so it reflects the session the
    /// prompt actually goes to (a fresh session has cursor -1 and gets the whole thread).
    fn build_prompt(&self, job: &Job) -> Result<Vec<ContentBlock>, String> {
        let store = &self.ctx.store;
        let transcript = store
            .list_messages(&self.task_id)
            .map_err(|e| format!("{e:#}"))?;
        let user = transcript
            .iter()
            .find(|m| m.id == job.user_message_id)
            .ok_or_else(|| "user message not found".to_string())?;
        let cursor = store
            .cursor(&self.task_id, &self.agent)
            .map_err(|e| format!("{e:#}"))?;
        let text = handoff::build_prompt(&transcript, cursor, user);
        store
            .set_cursor(
                &self.task_id,
                &self.agent,
                handoff::seen_through(&transcript, &user.id),
            )
            .map_err(|e| format!("{e:#}"))?;
        Ok(content_blocks(text, &user.parts))
    }

    fn lock_options(&self) -> std::sync::MutexGuard<'_, Options> {
        self.options.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn emit_config(&self) {
        let options = self.lock_options().to_json();
        self.ctx.out.notify(
            "agent.config",
            json!({ "task_id": self.task_id, "agent": self.agent, "options": options }),
        );
    }

    fn finish(&self, live: Live, outcome: Result<bool, String>) {
        finish_message(&self.ctx, &self.task_id, &self.agent, live, outcome);
    }

    fn on_update(&self, update: SessionUpdate) {
        match update {
            SessionUpdate::ConfigOptionUpdate(u) => {
                self.lock_options().config = u.config_options;
                self.emit_config();
            }
            SessionUpdate::CurrentModeUpdate(u) => {
                self.lock_options().set_mode(&u.current_mode_id);
                self.emit_config();
            }
            update => {
                let mut guard = self.live.lock().unwrap_or_else(|e| e.into_inner());
                let Some(live) = guard.as_mut() else {
                    return;
                };
                if let Some(index) = live.apply(update) {
                    emit_part(
                        &self.ctx,
                        &self.task_id,
                        &live.message_id,
                        index,
                        &live.parts[index],
                    );
                }
            }
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

/// The ACP content for a prompt: the text (handoff + message) first, then the user's
/// attachments as image blocks and `file://` resource links.
fn content_blocks(text: String, parts: &[Part]) -> Vec<ContentBlock> {
    let mut blocks = vec![ContentBlock::Text(TextContent::new(text))];
    for part in parts {
        match part {
            Part::Image { mime_type, data } => {
                blocks.push(ContentBlock::Image(ImageContent::new(
                    data.clone(),
                    mime_type.clone(),
                )));
            }
            Part::File { path, name } => {
                blocks.push(ContentBlock::ResourceLink(ResourceLink::new(
                    name.clone(),
                    file_uri(path),
                )));
            }
            _ => {}
        }
    }
    blocks
}

fn file_uri(path: &str) -> String {
    if path.starts_with('/') {
        format!("file://{path}")
    } else {
        format!("file:///{}", path.replace('\\', "/"))
    }
}

fn emit_part(ctx: &Ctx, task_id: &str, message_id: &str, index: usize, part: &Part) {
    ctx.out.notify(
        "chat.update",
        json!({ "task_id": task_id, "message_id": message_id, "part_index": index, "part": part }),
    );
}

/// Persist the assistant Message, advance the agent's cursor past it, and emit `chat.done`.
/// `outcome` is `Ok(cancelled)` or `Err(error text)`.
fn finish_message(
    ctx: &Ctx,
    task_id: &str,
    agent: &str,
    mut live: Live,
    outcome: Result<bool, String>,
) {
    let (status, error) = match outcome {
        Ok(false) => ("done", None),
        Ok(true) => ("cancelled", None),
        Err(e) => {
            let index = live.parts.len();
            live.parts.push(Part::Error { message: e.clone() });
            emit_part(ctx, task_id, &live.message_id, index, &live.parts[index]);
            ("error", Some(e))
        }
    };
    let store = &ctx.store;
    if let Err(e) = store.finish_message(&live.message_id, &live.parts, status) {
        warn!("persist assistant message: {e:#}");
    }
    match store.list_messages(task_id) {
        Ok(transcript) => {
            if let Some(index) = transcript.iter().position(|m| m.id == live.message_id) {
                let seen = store.cursor(task_id, agent).unwrap_or(-1);
                if index as i64 > seen {
                    if let Err(e) = store.set_cursor(task_id, agent, index as i64) {
                        warn!("advance cursor: {e:#}");
                    }
                }
            }
        }
        Err(e) => warn!("reload transcript: {e:#}"),
    }
    let mut params = json!({ "task_id": task_id, "message_id": live.message_id, "status": status });
    if let Some(e) = error {
        params["error"] = json!(e);
    }
    ctx.out.notify("chat.done", params);
}

fn option_json(o: &PermissionOption) -> Value {
    json!({ "id": o.option_id.0, "label": o.name, "kind": enum_str(&o.kind) })
}

fn enum_str<T: Serialize>(v: &T) -> String {
    match serde_json::to_value(v) {
        Ok(Value::String(s)) => s,
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
        ContentChunk, SessionConfigBoolean, SessionConfigSelect, SessionMode, ToolCallStatus,
        ToolCallUpdateFields, ToolKind,
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

    #[test]
    fn attachments_become_image_and_resource_link_blocks() {
        let parts = vec![
            Part::Text { text: "see".into() },
            Part::Image {
                mime_type: "image/png".into(),
                data: "QUJD".into(),
            },
            Part::File {
                path: "/tmp/demo/notes.md".into(),
                name: "notes.md".into(),
            },
        ];
        let blocks = content_blocks("prompt text".into(), &parts);
        assert_eq!(blocks.len(), 3);
        assert!(matches!(&blocks[0], ContentBlock::Text(t) if t.text == "prompt text"));
        assert!(matches!(
            &blocks[1],
            ContentBlock::Image(i) if i.data == "QUJD" && i.mime_type == "image/png"
        ));
        assert!(matches!(
            &blocks[2],
            ContentBlock::ResourceLink(r) if r.name == "notes.md" && r.uri == "file:///tmp/demo/notes.md"
        ));
        assert_eq!(file_uri("C:\\work\\a.txt"), "file:///C:/work/a.txt");
    }

    #[test]
    fn mode_kind_from_meta_reaches_the_app() {
        let mut meta = serde_json::Map::new();
        meta.insert("kind".into(), json!("full_access"));
        let o = SessionConfigSelectOption::new("agent-full-access", "Full access").meta(meta);
        let v = select_option_json(&o, None);
        assert_eq!(v["kind"], "full_access");
        assert_eq!(v["value"], "agent-full-access");
        let plain = select_option_json(&SessionConfigSelectOption::new("x", "X"), None);
        assert!(plain.get("kind").is_none());
    }

    fn model_option() -> SessionConfigOption {
        SessionConfigOption::new(
            "model",
            "Model",
            SessionConfigKind::Select(SessionConfigSelect::new(
                "sonnet",
                SessionConfigSelectOptions::Ungrouped(vec![
                    SessionConfigSelectOption::new("opus", "Opus").description("Big"),
                    SessionConfigSelectOption::new("sonnet", "Sonnet"),
                ]),
            )),
        )
        .category(SessionConfigOptionCategory::Model)
    }

    fn mode_option(current: &str) -> SessionConfigOption {
        SessionConfigOption::new(
            "mode",
            "Mode",
            SessionConfigKind::Select(SessionConfigSelect::new(
                SessionConfigValueId::new(current),
                SessionConfigSelectOptions::Ungrouped(vec![
                    SessionConfigSelectOption::new("default", "Manual"),
                    SessionConfigSelectOption::new("plan", "Plan"),
                ]),
            )),
        )
        .category(SessionConfigOptionCategory::Mode)
    }

    #[test]
    fn config_options_render_for_the_app() {
        let mut options = Options::default();
        options.set(
            Some(vec![
                model_option(),
                SessionConfigOption::new(
                    "fast",
                    "Fast mode",
                    SessionConfigKind::Boolean(SessionConfigBoolean::new(false)),
                )
                .category(SessionConfigOptionCategory::ModelConfig),
            ]),
            None,
        );
        let json = options.to_json();
        assert_eq!(
            json,
            vec![
                json!({
                    "id": "model", "name": "Model", "category": "model", "type": "select",
                    "current_value": "sonnet",
                    "options": [
                        { "value": "opus", "name": "Opus", "description": "Big" },
                        { "value": "sonnet", "name": "Sonnet" },
                    ],
                }),
                json!({
                    "id": "fast", "name": "Fast mode", "category": "model_config",
                    "type": "boolean", "current_value": false,
                }),
            ]
        );
        assert!(!options.is_mode_only("mode"));
    }

    #[test]
    fn modes_only_agent_gets_a_synthesized_mode_option() {
        let mut options = Options::default();
        let modes = SessionModeState::new(
            "default",
            vec![
                SessionMode::new("default", "Manual").description("Ask first"),
                SessionMode::new("plan", "Plan"),
            ],
        );
        options.set(None, Some(modes));
        assert!(options.is_mode_only("mode"));
        assert!(!options.is_mode_only("model"));
        assert_eq!(
            options.to_json(),
            vec![json!({
                "id": "mode", "name": "Mode", "category": "mode", "type": "select",
                "current_value": "default",
                "options": [
                    { "value": "default", "name": "Manual", "description": "Ask first" },
                    { "value": "plan", "name": "Plan" },
                ],
            })]
        );
        options.set_mode(&SessionModeId::new("plan"));
        assert_eq!(options.to_json()[0]["current_value"], "plan");
    }

    #[test]
    fn mode_update_reaches_the_mode_config_option() {
        let mut options = Options::default();
        options.set(
            Some(vec![model_option(), mode_option("default")]),
            Some(SessionModeState::new(
                "default",
                vec![
                    SessionMode::new("default", "Manual"),
                    SessionMode::new("plan", "Plan"),
                ],
            )),
        );
        // Config options win over the modes list, and the mode option is set through
        // `session/set_config_option` like any other.
        assert!(!options.is_mode_only("mode"));
        options.set_mode(&SessionModeId::new("plan"));
        let json = options.to_json();
        assert_eq!(json.len(), 2);
        assert_eq!(json[0]["current_value"], "sonnet");
        assert_eq!(json[1]["current_value"], "plan");
        assert_eq!(
            options
                .modes
                .as_ref()
                .map(|m| m.current_mode_id.0.to_string()),
            Some("plan".to_string())
        );
    }
}
