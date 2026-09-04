//! ACP agent pool: one adapter process + session per (task, agent), driven lazily.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agent_client_protocol::schema::v1::{
    AgentNotification, CancelNotification, ClientCapabilities, ContentBlock,
    CreateElicitationRequest, CreateElicitationResponse, ElicitationAction,
    ElicitationCapabilities, ElicitationFormCapabilities, ElicitationUrlCapabilities,
    ExtNotification, ImageContent, InitializeRequest, LoadSessionRequest, McpServer, Meta,
    NewSessionRequest, PermissionOption, PromptRequest, PromptResponse, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, ResourceLink, SelectedPermissionOutcome,
    SessionConfigId, SessionConfigKind, SessionConfigOption, SessionConfigOptionCategory,
    SessionConfigOptionValue, SessionConfigSelectOption, SessionConfigSelectOptions,
    SessionConfigValueId, SessionId, SessionModeId, SessionModeState, SessionUpdate,
    SetSessionConfigOptionRequest, SetSessionModeRequest, StopReason, TextContent, ToolCall,
    ToolCallContent, ToolCallUpdate,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, Agent, Client, ConnectionTo};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use tracing::{info, warn};

use crate::handoff;
use crate::store::{new_id, Part, Store};
use crate::Ctx;
use agent_client_protocol::AcpAgentConfig;

struct Spec {
    id: &'static str,
    name: &'static str,
    /// Adapter binaries to look for on PATH when the app did not hand core one.
    adapters: &'static [&'static str],
}

const SPECS: &[Spec] = &[
    Spec {
        id: "claude",
        name: "Claude Code",
        adapters: &["claude-agent-acp", "claude-code-acp"],
    },
    Spec {
        id: "codex",
        name: "Codex",
        adapters: &["codex-acp"],
    },
];

#[derive(Serialize)]
pub struct AgentInfo {
    id: &'static str,
    name: &'static str,
    available: bool,
    command: String,
    /// Why the agent cannot be used right now, when it cannot.
    #[serde(skip_serializing_if = "Option::is_none")]
    hint: Option<String>,
}

/// What stops the agent from serving a prompt on this machine, if anything. The adapters
/// bring Claude Code and Codex themselves; what they need is the user's sign-in.
fn hint(id: &str) -> Option<String> {
    match id {
        "codex" => {
            let home = std::env::var_os("CODEX_HOME")
                .map(std::path::PathBuf::from)
                .or_else(|| {
                    std::env::var_os("HOME")
                        .or_else(|| std::env::var_os("USERPROFILE"))
                        .map(|h| std::path::PathBuf::from(h).join(".codex"))
                })?;
            (!home.join("auth.json").is_file()).then(|| "Sign in first: run `codex login`".into())
        }
        _ => None,
    }
}

fn spec(id: &str) -> Option<&'static Spec> {
    SPECS.iter().find(|s| s.id == id)
}

pub fn is_known(id: &str) -> bool {
    spec(id).is_some()
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

/// Host-provided additions to every ACP session for one agent. Core keeps this
/// protocol-native and does not know any provider-specific tool names or prompt text.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionProfile {
    #[serde(default)]
    mcp_servers: Vec<McpServer>,
    #[serde(default, rename = "_meta")]
    meta: Option<Meta>,
}

#[derive(Default)]
pub struct AgentPool {
    /// Adapter launch config per agent id, as handed to core by the app.
    adapters: HashMap<String, AcpAgentConfig>,
    /// ACP session additions per agent id, supplied by the desktop host.
    session_profiles: HashMap<String, SessionProfile>,
    handles: Mutex<HashMap<(String, String), Handle>>,
    next_generation: Mutex<u64>,
}

/// How long a config change may take before the app is told the agent did not answer.
const SET_CONFIG_TIMEOUT: Duration = Duration::from_secs(30);
const SET_CONFIG_TIMED_OUT: &str = "agent did not answer in time";

impl AgentPool {
    pub fn new(
        adapters: HashMap<String, AcpAgentConfig>,
        session_profiles: HashMap<String, SessionProfile>,
    ) -> Self {
        Self {
            adapters,
            session_profiles,
            ..Self::default()
        }
    }

    /// How to launch the adapter for `agent`: the app's config, else a binary on PATH.
    fn adapter(&self, agent: &str) -> Option<AcpAgentConfig> {
        if let Some(c) = self.adapters.get(agent) {
            return Some(c.clone());
        }
        let s = spec(agent)?;
        let path = s.adapters.iter().find_map(|a| which::which(a).ok())?;
        Some(AcpAgentConfig::new(path))
    }

    pub fn list(&self) -> Vec<AgentInfo> {
        SPECS
            .iter()
            .map(|s| {
                let adapter = self.adapter(s.id);
                let hint = match &adapter {
                    Some(_) => hint(s.id),
                    None => Some(format!("No adapter for {}", s.name)),
                };
                AgentInfo {
                    id: s.id,
                    name: s.name,
                    available: hint.is_none(),
                    command: adapter
                        .map(|c| {
                            let mut parts = vec![c.command().to_string_lossy().into_owned()];
                            parts.extend(c.arguments().iter().cloned());
                            parts.join(" ")
                        })
                        .unwrap_or_default(),
                    hint,
                }
            })
            .collect()
    }

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
            loading: Arc::default(),
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

    /// Forget every connection for one provider. This is used when the user disables a
    /// local provider in Settings, so no adapter process remains active in OpenYak.
    pub fn drop_agent(&self, agent: &str) {
        let mut handles = self.handles.lock().unwrap_or_else(|e| e.into_inner());
        for ((_, handle_agent), handle) in handles.iter() {
            if handle_agent == agent {
                let _ = handle.cancel.send(());
            }
        }
        handles.retain(|(_, handle_agent), _| handle_agent != agent);
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
    started_at: Instant,
    /// When the parts were last written to the store (see `Live::persist`).
    last_persisted: Instant,
}

/// Id of the synthesized option for agents that only speak the older modes API.
const MODE_OPTION_ID: &str = "mode";

/// What the agent advertises for its session: config options (model, effort, mode…) and,
/// for agents that only speak the older modes API, the mode list.
#[derive(Default)]
struct Options {
    config: Vec<SessionConfigOption>,
    modes: Option<SessionModeState>,
    /// Values an agent advertised but then definitively rejected for this session.
    /// Keep these across config refreshes so the app cannot immediately retry them.
    unavailable: HashMap<String, HashMap<String, String>>,
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

    fn mark_unavailable(&mut self, config_id: &str, value: &Value, reason: String) {
        let Some(value) = config_value_key(value) else {
            return;
        };
        self.unavailable
            .entry(config_id.to_string())
            .or_default()
            .insert(value, reason);
    }

    fn clear_unavailable(&mut self, config_id: &str, value: &Value) {
        let Some(value) = config_value_key(value) else {
            return;
        };
        if let Some(values) = self.unavailable.get_mut(config_id) {
            values.remove(&value);
            if values.is_empty() {
                self.unavailable.remove(config_id);
            }
        }
    }

    fn decorate_unavailable(&self, config_id: &str, option: &mut Value) {
        let Some(values) = self.unavailable.get(config_id) else {
            return;
        };
        let Some(options) = option.get_mut("options").and_then(Value::as_array_mut) else {
            return;
        };
        for candidate in options {
            let Some(value) = candidate.get("value").and_then(Value::as_str) else {
                continue;
            };
            let Some(reason) = values.get(value) else {
                continue;
            };
            candidate["disabled"] = json!(true);
            candidate["disabled_reason"] = json!(reason);
        }
    }

    /// The options as the app sees them (`agent.config` in docs/core-protocol.md).
    fn to_json(&self) -> Vec<Value> {
        if !self.config.is_empty() {
            return self
                .config
                .iter()
                .map(|option| {
                    let mut value = config_option_json(option);
                    self.decorate_unavailable(&option.id.0, &mut value);
                    value
                })
                .collect();
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
        let mut mode = json!({
            "id": MODE_OPTION_ID,
            "name": "Mode",
            "category": "mode",
            "type": "select",
            "current_value": &*m.current_mode_id.0,
            "options": options,
        });
        self.decorate_unavailable(MODE_OPTION_ID, &mut mode);
        vec![mode]
    }
}

fn config_value_key(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
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
    /// True while a `session/load` request is in flight: the transcript the agent replays
    /// then is already held as Messages and is not stored again (see `on_update`).
    loading: Arc<AtomicBool>,
}

type AcpResult<T> = Result<T, agent_client_protocol::Error>;

fn client_capabilities() -> ClientCapabilities {
    ClientCapabilities::new().elicitation(
        ElicitationCapabilities::new()
            .form(ElicitationFormCapabilities::new())
            .url(ElicitationUrlCapabilities::new()),
    )
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
        mut commands: mpsc::UnboundedReceiver<Command>,
        mut cancels: mpsc::UnboundedReceiver<()>,
    ) {
        let adapter = self.ctx.agents.adapter(&self.agent);
        info!(agent = %self.agent, task = %self.task_id, adapter = ?adapter, "starting agent");
        self.status("starting", None);

        let result = match adapter {
            Some(config) => {
                let adapter =
                    AcpAgent::new(config).with_debug(|line, dir| tracing::debug!(?dir, "{line}"));
                let commands = &mut commands;
                let cancels = &mut cancels;
                let updates = self.clone();
                let perms = self.clone();
                let elicitations = self.clone();
                Client
                    .builder()
                    .on_receive_notification(
                        async move |n: AgentNotification, _cx| {
                            match n {
                                AgentNotification::SessionNotification(n) => {
                                    updates.on_update(n.update)
                                }
                                AgentNotification::ExtNotification(n) => updates.on_ext(n),
                                _ => {}
                            }
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
                    .on_receive_request(
                        async move |req: CreateElicitationRequest, responder, _cx| {
                            elicitations.on_elicitation(req, responder);
                            Ok(())
                        },
                        agent_client_protocol::on_receive_request!(),
                    )
                    .connect_with(adapter, async move |connection: ConnectionTo<Agent>| {
                        self.serve(connection, commands, cancels).await
                    })
                    .await
                    .map_err(|e| error_text(&e))
            }
            None => Err(format!("no adapter configured for {}", self.agent)),
        };

        let detail = result.err();
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
            .send_request(
                InitializeRequest::new(ProtocolVersion::V1)
                    .client_capabilities(client_capabilities()),
            )
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
            let mut load = LoadSessionRequest::new(SessionId::new(saved.clone()), self.cwd.clone());
            if let Some(profile) = self.ctx.agents.session_profiles.get(&self.agent) {
                load = load
                    .mcp_servers(profile.mcp_servers.clone())
                    .meta(profile.meta.clone());
            }
            // Nothing between the two stores can return early, so the flag cannot stay set.
            self.loading.store(true, Ordering::SeqCst);
            let loaded = connection.send_request(load).block_task().await;
            self.loading.store(false, Ordering::SeqCst);
            match loaded {
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
        let mut new_session = NewSessionRequest::new(self.cwd.clone());
        if let Some(profile) = self.ctx.agents.session_profiles.get(&self.agent) {
            new_session = new_session
                .mcp_servers(profile.mcp_servers.clone())
                .meta(profile.meta.clone());
        }
        let resp = connection.send_request(new_session).block_task().await?;
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
        let result = tokio::time::timeout(SET_CONFIG_TIMEOUT, request)
            .await
            .unwrap_or_else(|_| Err(SET_CONFIG_TIMED_OUT.to_string()));
        if let Err(error) = result {
            if is_definitive_config_rejection(&error) {
                self.lock_options()
                    .mark_unavailable(config_id, value, error.clone());
                self.emit_config();
            }
            return Err(error);
        }
        self.lock_options().clear_unavailable(config_id, value);
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
                self.finish(live, Ok(resp));
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

    fn finish(&self, live: Live, outcome: Result<PromptResponse, String>) {
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
                    drop(guard);
                    // While `session/load` is in flight the agent replays its transcript as
                    // message, thought and tool-call updates; core already holds those turns
                    // as Messages, so they are not stored a second time. Anything else that
                    // arrives during the load (the command list, usage) is kept as usual.
                    if self.loading.load(Ordering::SeqCst)
                        && matches!(
                            update,
                            SessionUpdate::UserMessageChunk(_)
                                | SessionUpdate::AgentMessageChunk(_)
                                | SessionUpdate::AgentThoughtChunk(_)
                                | SessionUpdate::ToolCall(_)
                                | SessionUpdate::ToolCallUpdate(_)
                        )
                    {
                        tracing::debug!(
                            agent = %self.agent, task = %self.task_id,
                            "skipping transcript replayed by session/load"
                        );
                        return;
                    }
                    let (kind, data) = event_of(&update);
                    self.store_event(&kind, data);
                    return;
                };
                if let Some(index) = live.apply(update) {
                    self.changed(live, index);
                }
            }
        }
    }

    /// An extension notification (`_vendor/...`) from the agent, kept like any other
    /// update: as an event part of the streaming reply, or as an AgentEvent.
    fn on_ext(&self, n: ExtNotification) {
        let (kind, data) = ext_event(&n);
        let mut guard = self.live.lock().unwrap_or_else(|e| e.into_inner());
        let Some(live) = guard.as_mut() else {
            drop(guard);
            // Raw SDK user messages replay during session/load. Their normalized Artifact
            // events are already part of the stored Message, so do not duplicate them as
            // task-level events when restoring an Agent session.
            if self.loading.load(Ordering::SeqCst) && kind == "_claude/sdkMessage" {
                return;
            }
            self.store_event(&kind, data);
            return;
        };
        // Keep the provider envelope for fidelity, then append any common host events it
        // declares. Renderer code consumes only artifact.* and never inspects Claude tool
        // names, raw SDK messages, or prose output.
        let normalized = crate::artifacts::from_adapter_event(&kind, &data, &live.parts);
        let raw_index = live.event(kind, data);
        self.changed(live, raw_index);
        for (event_kind, event_data) in normalized {
            let index = live.event(event_kind, event_data);
            self.changed(live, index);
        }
    }

    /// A part of the streaming reply changed: tell the app and write it through.
    fn changed(&self, live: &mut Live, index: usize) {
        emit_part(
            &self.ctx,
            &self.task_id,
            &live.message_id,
            index,
            &live.parts[index],
        );
        live.persist(&self.ctx.store, index);
    }

    /// Keep and announce an update that arrived while no reply was streaming.
    fn store_event(&self, kind: &str, data: Value) {
        match self
            .ctx
            .store
            .insert_event(&self.task_id, &self.agent, kind, data)
        {
            Ok(event) => self.ctx.out.notify("chat.event", json!(event)),
            Err(e) => warn!("persist agent event: {e:#}"),
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
        self.ctx.out.request(
            &request_id,
            "permission.request",
            permission_json(&request_id, &self.task_id, &self.agent, &req),
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

    fn on_elicitation(
        &self,
        req: CreateElicitationRequest,
        responder: agent_client_protocol::Responder<CreateElicitationResponse>,
    ) {
        let request_id = new_id();
        let (tx, rx) = oneshot::channel();
        self.ctx.register_elicitation(request_id.clone(), tx);
        let mut params = serde_json::to_value(&req).unwrap_or(Value::Null);
        if let Value::Object(fields) = &mut params {
            fields.insert("request_id".into(), json!(request_id));
            fields.insert("task_id".into(), json!(self.task_id));
            fields.insert("agent".into(), json!(self.agent));
        }
        self.ctx
            .out
            .request(&request_id, "elicitation.request", params);
        let ctx = self.ctx.clone();
        tokio::spawn(async move {
            let value = rx.await.unwrap_or_else(|_| json!({ "action": "cancel" }));
            ctx.forget_elicitation(&request_id);
            let response = serde_json::from_value(value).unwrap_or_else(|e| {
                warn!("invalid elicitation response: {e}");
                CreateElicitationResponse::new(ElicitationAction::Cancel)
            });
            if let Err(e) = responder.respond(response) {
                warn!("elicitation response: {}", error_text(&e));
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
/// `outcome` is the agent's `PromptResponse` or `Err(error text)`.
fn finish_message(
    ctx: &Ctx,
    task_id: &str,
    agent: &str,
    mut live: Live,
    outcome: Result<PromptResponse, String>,
) {
    let duration_ms = live.started_at.elapsed().as_millis().min(i64::MAX as u128) as i64;
    let (status, error) = match &outcome {
        Ok(resp) if live.cancelled || resp.stop_reason == StopReason::Cancelled => {
            ("cancelled", None)
        }
        Ok(_) => ("done", None),
        Err(e) => {
            let index = live.parts.len();
            live.parts.push(Part::Error { message: e.clone() });
            emit_part(ctx, task_id, &live.message_id, index, &live.parts[index]);
            ("error", Some(e.clone()))
        }
    };
    // The ACP stop reason, usage and meta are passed on as reported, whatever the status.
    let (stop_reason, usage, meta) = match &outcome {
        Ok(resp) => (
            Some(enum_str(&resp.stop_reason)),
            resp.usage
                .as_ref()
                .map(|u| serde_json::to_value(u).unwrap_or(Value::Null)),
            resp.meta.clone(),
        ),
        Err(_) => (None, None, None),
    };
    let store = &ctx.store;
    if let Err(e) = store.finish_message(
        &live.message_id,
        &live.parts,
        status,
        duration_ms,
        stop_reason.as_deref(),
        usage.as_ref(),
    ) {
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
    let mut params = json!({
        "task_id": task_id,
        "message_id": live.message_id,
        "status": status,
        "duration_ms": duration_ms
    });
    if let Some(e) = error {
        params["error"] = json!(e);
    }
    if let Some(s) = stop_reason {
        params["stop_reason"] = json!(s);
    }
    if let Some(u) = usage {
        params["usage"] = u;
    }
    if let Some(m) = meta {
        params["_meta"] = json!(m);
    }
    ctx.out.notify("chat.done", params);
}

/// The `permission.request` params: a title and the options for the app's prompt, plus the
/// ACP `ToolCallUpdate` and the request's meta verbatim.
fn permission_json(
    request_id: &str,
    task_id: &str,
    agent: &str,
    req: &RequestPermissionRequest,
) -> Value {
    let title = req
        .tool_call
        .fields
        .title
        .clone()
        .unwrap_or_else(|| req.tool_call.tool_call_id.0.to_string());
    let options: Vec<_> = req.options.iter().map(option_json).collect();
    let mut params = json!({
        "request_id": request_id,
        "task_id": task_id,
        "agent": agent,
        "title": title,
        "options": options,
        "tool_call": serde_json::to_value(&req.tool_call).unwrap_or(Value::Null),
    });
    if let Some(m) = &req.meta {
        params["_meta"] = json!(m);
    }
    params
}

fn option_json(o: &PermissionOption) -> Value {
    let mut v = json!({ "id": o.option_id.0, "label": o.name, "kind": enum_str(&o.kind) });
    if let Some(m) = &o.meta {
        v["_meta"] = json!(m);
    }
    v
}

fn enum_str<T: Serialize>(v: &T) -> String {
    match serde_json::to_value(v) {
        Ok(Value::String(s)) => s,
        Ok(other) => other.to_string(),
        Err(_) => String::new(),
    }
}

pub fn error_text(e: &agent_client_protocol::Error) -> String {
    if let Some(details) = e
        .data
        .as_ref()
        .and_then(|data| data.get("details"))
        .and_then(Value::as_str)
    {
        return details.to_string();
    }
    match &e.data {
        Some(data) => format!("{} ({data})", e.message),
        None => e.message.clone(),
    }
}

/// Only disable an advertised value when the response proves it cannot work in this
/// session. Timeouts, disconnects, and generic internal errors remain retryable.
fn is_definitive_config_rejection(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    [
        "disabled by settings",
        "not supported",
        "unsupported",
        "option is not available",
        "mode is not available",
        "invalid option",
    ]
    .iter()
    .any(|needle| error.contains(needle))
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

/// ACP items as they came over the wire, for the verbatim fields of a tool call part.
fn json_list<T: Serialize>(items: &[T]) -> Vec<Value> {
    items
        .iter()
        .map(|i| serde_json::to_value(i).unwrap_or(Value::Null))
        .collect()
}

/// An update kept verbatim as an event: its ACP `sessionUpdate` discriminator and the
/// whole update object.
fn event_of(update: &SessionUpdate) -> (String, Value) {
    let data = serde_json::to_value(update).unwrap_or(Value::Null);
    let kind = data
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    (kind, data)
}

/// An extension notification kept verbatim: its wire method name (the crate strips the
/// leading `_` when it routes the notification) and its params.
fn ext_event(n: &ExtNotification) -> (String, Value) {
    let data = serde_json::from_str(n.params.get()).unwrap_or(Value::Null);
    (format!("_{}", n.method), data)
}

/// Text and thought parts are written through at most this often; tool calls and events
/// always are (docs/core-protocol.md, "Fidelity rule").
const PERSIST_TEXT_EVERY: Duration = Duration::from_secs(2);

impl Live {
    fn new(message_id: String) -> Self {
        let now = Instant::now();
        Self {
            message_id,
            parts: Vec::new(),
            tools: HashMap::new(),
            cancelled: false,
            started_at: now,
            last_persisted: now,
        }
    }

    /// Fold one ACP update into the parts; returns the index of the part that changed.
    fn apply(&mut self, update: SessionUpdate) -> Option<usize> {
        match update {
            SessionUpdate::AgentMessageChunk(c) if matches!(c.content, ContentBlock::Text(_)) => {
                let meta = c.meta;
                let message_id = c.message_id.map(|id| id.0.to_string());
                let text = chunk_text(c.content).filter(|t| !t.is_empty())?;
                Some(self.append_text(text, false, meta, message_id))
            }
            SessionUpdate::AgentThoughtChunk(c) if matches!(c.content, ContentBlock::Text(_)) => {
                let meta = c.meta;
                let message_id = c.message_id.map(|id| id.0.to_string());
                let text = chunk_text(c.content).filter(|t| !t.is_empty())?;
                Some(self.append_text(text, true, meta, message_id))
            }
            SessionUpdate::ToolCall(tc) => Some(self.tool_call(tc)),
            SessionUpdate::ToolCallUpdate(u) => Some(self.tool_call_update(u)),
            // Everything else (plans, usage, session info, user chunks, chunks whose
            // content is not text, …) is kept verbatim rather than dropped.
            other => {
                let (kind, data) = event_of(&other);
                Some(self.event(kind, data))
            }
        }
    }

    fn event(&mut self, kind: String, data: Value) -> usize {
        self.parts.push(Part::Event { kind, data });
        self.parts.len() - 1
    }

    /// Write the parts so far, so a core that dies mid-reply leaves what it had received:
    /// always after a tool call or event, at most every `PERSIST_TEXT_EVERY` after text.
    fn persist(&mut self, store: &Store, index: usize) {
        let now = Instant::now();
        if matches!(self.parts[index], Part::Text { .. } | Part::Thought { .. })
            && now.duration_since(self.last_persisted) < PERSIST_TEXT_EVERY
        {
            return;
        }
        self.last_persisted = now;
        if let Err(e) = store.update_parts(&self.message_id, &self.parts) {
            warn!("persist streaming parts: {e:#}");
        }
    }

    fn append_text(
        &mut self,
        delta: String,
        thought: bool,
        meta: Option<agent_client_protocol::schema::v1::Meta>,
        message_id: Option<String>,
    ) -> usize {
        if let Some(last) = self.parts.last_mut() {
            match (last, thought) {
                (
                    Part::Text {
                        text,
                        meta: current_meta,
                        message_id: current_message_id,
                    },
                    false,
                )
                | (
                    Part::Thought {
                        text,
                        meta: current_meta,
                        message_id: current_message_id,
                    },
                    true,
                ) if *current_meta == meta && *current_message_id == message_id => {
                    text.push_str(&delta);
                    return self.parts.len() - 1;
                }
                _ => {}
            }
        }
        self.parts.push(if thought {
            Part::Thought {
                text: delta,
                meta,
                message_id,
            }
        } else {
            Part::Text {
                text: delta,
                meta,
                message_id,
            }
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
            content: (!tc.content.is_empty()).then(|| json_list(&tc.content)),
            locations: (!tc.locations.is_empty()).then(|| json_list(&tc.locations)),
            raw_input: tc.raw_input,
            raw_output: tc.raw_output,
            meta: tc.meta,
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
                    content: None,
                    locations: None,
                    raw_input: None,
                    raw_output: None,
                    meta: u.meta.clone(),
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
            content,
            locations,
            raw_input,
            raw_output,
            meta,
            ..
        } = &mut self.parts[index]
        {
            if u.meta.is_some() {
                *meta = u.meta;
            }
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
            // A field the update carries replaces the stored one (ACP semantics); `output`
            // keeps the derived text of the latest content that had any.
            if let Some(c) = f.content {
                if let Some(o) = tool_output(&c) {
                    *output = Some(o);
                }
                *content = Some(json_list(&c));
            }
            if let Some(l) = f.locations {
                *locations = Some(json_list(&l));
            }
            if let Some(i) = f.raw_input {
                *raw_input = Some(i);
            }
            if let Some(o) = f.raw_output {
                *raw_output = Some(o);
            }
        }
        index
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{
        AvailableCommand, AvailableCommandsUpdate, ContentChunk, Diff, Meta, PermissionOptionKind,
        Plan, PlanEntry, PlanEntryPriority, PlanEntryStatus, SessionConfigBoolean,
        SessionConfigSelect, SessionInfoUpdate, SessionMode, ToolCallLocation, ToolCallStatus,
        ToolCallUpdateFields, ToolKind, Usage, UsageUpdate,
    };

    /// A core context with an in-memory store; the receiver sees every line sent to the app.
    fn test_ctx() -> (Arc<Ctx>, mpsc::UnboundedReceiver<String>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let ctx = Arc::new(Ctx {
            store: Store::in_memory().unwrap(),
            out: crate::rpc::Outbound(tx),
            agents: AgentPool::default(),
            projectless_dir: String::new(),
            permissions: Mutex::default(),
            elicitations: Mutex::default(),
        });
        (ctx, rx)
    }

    fn next_line(rx: &mut mpsc::UnboundedReceiver<String>) -> Value {
        serde_json::from_str(&rx.try_recv().expect("a line for the app")).unwrap()
    }

    fn chunk(s: &str) -> ContentChunk {
        ContentChunk::new(ContentBlock::Text(TextContent::new(s)))
    }

    #[test]
    fn client_advertises_only_elicitation_capabilities_it_implements() {
        let value = serde_json::to_value(client_capabilities()).unwrap();
        assert_eq!(value["elicitation"], json!({ "form": {}, "url": {} }));
        assert_eq!(value["terminal"], false);
        assert_eq!(
            value["fs"],
            json!({ "readTextFile": false, "writeTextFile": false })
        );
    }

    #[test]
    fn session_profiles_are_acp_native_and_keep_provider_meta_opaque() {
        let profile: SessionProfile = serde_json::from_value(json!({
            "mcpServers": [{ "name": "host", "command": "/opt/host-mcp", "args": [], "env": [] }],
            "_meta": { "provider": { "futureOption": true } }
        }))
        .unwrap();
        assert_eq!(profile.mcp_servers.len(), 1);
        assert_eq!(profile.meta.unwrap()["provider"]["futureOption"], true);
    }

    fn phased_chunk(s: &str, phase: &str) -> ContentChunk {
        ContentChunk::new(ContentBlock::Text(TextContent::new(s)))
            .message_id("message-1")
            .meta(agent_client_protocol::schema::v1::Meta::from_iter([(
                "codex".into(),
                serde_json::json!({ "phase": phase }),
            )]))
    }

    #[test]
    fn disabling_a_provider_drops_only_its_sessions() {
        let pool = AgentPool::default();
        let (codex_commands, codex_commands_rx) = mpsc::unbounded_channel();
        let (codex_cancel, mut codex_cancel_rx) = mpsc::unbounded_channel();
        let (claude_commands, claude_commands_rx) = mpsc::unbounded_channel();
        let (claude_cancel, mut claude_cancel_rx) = mpsc::unbounded_channel();
        {
            let mut handles = pool.handles.lock().unwrap();
            handles.insert(
                ("task-a".into(), "codex".into()),
                Handle {
                    generation: 1,
                    task_id: "task-a".into(),
                    commands: codex_commands,
                    cancel: codex_cancel,
                },
            );
            handles.insert(
                ("task-b".into(), "claude".into()),
                Handle {
                    generation: 2,
                    task_id: "task-b".into(),
                    commands: claude_commands,
                    cancel: claude_cancel,
                },
            );
        }

        pool.drop_agent("codex");

        let handles = pool.handles.lock().unwrap();
        assert!(!handles.contains_key(&("task-a".into(), "codex".into())));
        assert!(handles.contains_key(&("task-b".into(), "claude".into())));
        drop(handles);
        assert_eq!(codex_cancel_rx.try_recv(), Ok(()));
        assert!(codex_commands_rx.is_closed());
        assert!(claude_cancel_rx.try_recv().is_err());
        assert!(!claude_commands_rx.is_closed());
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
                text: "PONG".into(),
                meta: None,
                message_id: None,
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
    fn text_chunks_preserve_phase_metadata_and_do_not_merge_across_phases() {
        let mut live = Live::new("m".into());
        assert_eq!(
            live.apply(SessionUpdate::AgentMessageChunk(phased_chunk(
                "Checking",
                "commentary"
            ))),
            Some(0)
        );
        assert_eq!(
            live.apply(SessionUpdate::AgentMessageChunk(phased_chunk(
                " files",
                "commentary"
            ))),
            Some(0)
        );
        assert_eq!(
            live.apply(SessionUpdate::AgentMessageChunk(phased_chunk(
                "Done.",
                "final_answer"
            ))),
            Some(1)
        );

        assert_eq!(live.parts.len(), 2);
        assert!(matches!(
            &live.parts[0],
            Part::Text { text, meta, .. }
                if text == "Checking files"
                    && meta.as_ref().and_then(|value| value.get("codex")).is_some()
        ));
        assert!(matches!(
            &live.parts[1],
            Part::Text { text, meta, .. }
                if text == "Done."
                    && meta.as_ref().and_then(|value| value.get("codex")).is_some()
        ));
    }

    #[test]
    fn tool_calls_update_in_place() {
        let mut live = Live::new("m".into());
        live.apply(SessionUpdate::AgentMessageChunk(chunk("x")));
        let tc = ToolCall::new("tc1", "ls").kind(ToolKind::Execute).meta(
            agent_client_protocol::schema::v1::Meta::from_iter([(
                "contextCompaction".into(),
                serde_json::json!({ "phase": "start" }),
            )]),
        );
        assert_eq!(live.apply(SessionUpdate::ToolCall(tc)), Some(1));
        let upd = ToolCallUpdate::new(
            "tc1",
            ToolCallUpdateFields::new()
                .status(ToolCallStatus::Completed)
                .content(vec![ToolCallContent::from(ContentBlock::Text(
                    TextContent::new("a\nb"),
                ))]),
        )
        .meta(agent_client_protocol::schema::v1::Meta::from_iter([(
            "contextCompaction".into(),
            serde_json::json!({ "phase": "complete" }),
        )]));
        assert_eq!(live.apply(SessionUpdate::ToolCallUpdate(upd)), Some(1));
        assert_eq!(
            live.parts[1],
            Part::ToolCall {
                id: "tc1".into(),
                title: "ls".into(),
                kind: "execute".into(),
                status: "completed".into(),
                output: Some("a\nb".into()),
                content: Some(vec![json!({
                    "type": "content",
                    "content": { "type": "text", "text": "a\nb" },
                })]),
                locations: None,
                raw_input: None,
                raw_output: None,
                meta: Some(serde_json::Map::from_iter([(
                    "contextCompaction".into(),
                    serde_json::json!({ "phase": "complete" }),
                )])),
            }
        );
    }

    #[test]
    fn tool_calls_keep_diff_locations_and_raw_io_verbatim() {
        let mut live = Live::new("m".into());
        let tc = ToolCall::new("tc1", "edit main.rs")
            .kind(ToolKind::Edit)
            .content(vec![ToolCallContent::from(
                Diff::new("/tmp/demo/main.rs", "fn main() {}").old_text("fn main() {\n}"),
            )])
            .locations(vec![ToolCallLocation::new("/tmp/demo/main.rs").line(1)])
            .raw_input(json!({ "path": "/tmp/demo/main.rs" }));
        let wire = serde_json::to_value(&tc).unwrap();
        assert_eq!(live.apply(SessionUpdate::ToolCall(tc)), Some(0));
        let Part::ToolCall {
            output,
            content,
            locations,
            raw_input,
            raw_output,
            ..
        } = &live.parts[0]
        else {
            panic!("not a tool call: {:?}", live.parts[0]);
        };
        // The derived text is what it was; the ACP arrays are the wire JSON, diff included.
        assert_eq!(output.as_deref(), Some("diff /tmp/demo/main.rs"));
        assert_eq!(
            content.as_deref(),
            wire["content"].as_array().map(Vec::as_slice)
        );
        assert_eq!(content.as_ref().unwrap()[0]["type"], "diff");
        assert_eq!(content.as_ref().unwrap()[0]["oldText"], "fn main() {\n}");
        assert_eq!(content.as_ref().unwrap()[0]["newText"], "fn main() {}");
        assert_eq!(
            locations.as_deref(),
            wire["locations"].as_array().map(Vec::as_slice)
        );
        assert_eq!(locations.as_ref().unwrap()[0]["line"], 1);
        assert_eq!(raw_input, &Some(json!({ "path": "/tmp/demo/main.rs" })));
        assert_eq!(raw_output, &None);

        // An update replaces exactly the fields it carries.
        let upd = ToolCallUpdate::new(
            "tc1",
            ToolCallUpdateFields::new()
                .status(ToolCallStatus::Completed)
                .content(vec![ToolCallContent::from(ContentBlock::Text(
                    TextContent::new("ok"),
                ))])
                .raw_output(json!({ "ok": true })),
        );
        assert_eq!(live.apply(SessionUpdate::ToolCallUpdate(upd)), Some(0));
        let Part::ToolCall {
            status,
            output,
            content,
            locations,
            raw_input,
            raw_output,
            ..
        } = &live.parts[0]
        else {
            panic!("not a tool call: {:?}", live.parts[0]);
        };
        assert_eq!(status, "completed");
        assert_eq!(output.as_deref(), Some("ok"));
        assert_eq!(
            content,
            &Some(vec![
                json!({ "type": "content", "content": { "type": "text", "text": "ok" } })
            ])
        );
        assert_eq!(locations.as_ref().unwrap()[0]["path"], "/tmp/demo/main.rs");
        assert_eq!(raw_input, &Some(json!({ "path": "/tmp/demo/main.rs" })));
        assert_eq!(raw_output, &Some(json!({ "ok": true })));
        // The part survives a store round trip with the wire shape intact.
        let json = serde_json::to_value(&live.parts[0]).unwrap();
        assert_eq!(json["content"][0]["type"], "content");
        assert_eq!(json["raw_output"]["ok"], true);
        assert_eq!(serde_json::from_value::<Part>(json).unwrap(), live.parts[0]);
    }

    #[test]
    fn every_other_update_becomes_an_event_part_in_order() {
        let mut live = Live::new("m".into());
        live.apply(SessionUpdate::AgentMessageChunk(chunk("hi")));
        let plan = Plan::new(vec![PlanEntry::new(
            "look",
            PlanEntryPriority::High,
            PlanEntryStatus::Pending,
        )]);
        let plan_wire = serde_json::to_value(SessionUpdate::Plan(plan.clone())).unwrap();
        assert_eq!(live.apply(SessionUpdate::Plan(plan)), Some(1));
        assert_eq!(
            live.apply(SessionUpdate::UsageUpdate(UsageUpdate::new(10, 100))),
            Some(2)
        );
        assert_eq!(
            live.apply(SessionUpdate::SessionInfoUpdate(
                SessionInfoUpdate::new().title(String::from("Renamed")),
            )),
            Some(3)
        );
        assert_eq!(
            live.apply(SessionUpdate::UserMessageChunk(chunk("echo"))),
            Some(4)
        );
        assert_eq!(
            live.apply(SessionUpdate::AvailableCommandsUpdate(
                AvailableCommandsUpdate::new(vec![AvailableCommand::new("init", "Start")]),
            )),
            Some(5)
        );
        // Text after an event starts a new part rather than merging across it.
        assert_eq!(
            live.apply(SessionUpdate::AgentMessageChunk(chunk("!"))),
            Some(6)
        );
        let kinds: Vec<&str> = live
            .parts
            .iter()
            .map(|p| match p {
                Part::Event { kind, .. } => kind.as_str(),
                Part::Text { .. } => "text",
                _ => "?",
            })
            .collect();
        assert_eq!(
            kinds,
            [
                "text",
                "plan",
                "usage_update",
                "session_info_update",
                "user_message_chunk",
                "available_commands_update",
                "text",
            ]
        );
        assert_eq!(
            live.parts[1],
            Part::Event {
                kind: "plan".into(),
                data: plan_wire,
            }
        );
        assert_eq!(
            live.parts[2],
            Part::Event {
                kind: "usage_update".into(),
                data: json!({ "sessionUpdate": "usage_update", "used": 10, "size": 100 }),
            }
        );
        assert!(matches!(
            &live.parts[3],
            Part::Event { data, .. } if data["title"] == "Renamed"
        ));
        assert!(matches!(
            &live.parts[4],
            Part::Event { data, .. } if data["content"]["text"] == "echo"
        ));
        assert!(matches!(
            &live.parts[5],
            Part::Event { data, .. } if data["availableCommands"][0]["name"] == "init"
        ));
    }

    #[test]
    fn non_text_chunks_become_events() {
        let mut live = Live::new("m".into());
        live.apply(SessionUpdate::AgentMessageChunk(chunk("see")));
        let image = ContentChunk::new(ContentBlock::Image(ImageContent::new("QUJD", "image/png")));
        assert_eq!(live.apply(SessionUpdate::AgentMessageChunk(image)), Some(1));
        let link = ContentChunk::new(ContentBlock::ResourceLink(ResourceLink::new(
            "notes.md",
            "file:///tmp/notes.md",
        )));
        assert_eq!(live.apply(SessionUpdate::AgentThoughtChunk(link)), Some(2));
        assert_eq!(
            live.parts[1],
            Part::Event {
                kind: "agent_message_chunk".into(),
                data: json!({
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "image", "data": "QUJD", "mimeType": "image/png" },
                }),
            }
        );
        assert!(matches!(
            &live.parts[2],
            Part::Event { kind, data }
                if kind == "agent_thought_chunk" && data["content"]["uri"] == "file:///tmp/notes.md"
        ));
        // Text after them starts a new part; empty text chunks are still ignored.
        assert_eq!(
            live.apply(SessionUpdate::AgentMessageChunk(chunk("more"))),
            Some(3)
        );
        assert_eq!(
            live.apply(SessionUpdate::AgentMessageChunk(chunk(""))),
            None
        );
    }

    #[test]
    fn extension_notifications_keep_their_wire_method_name() {
        // The crate routes `_claude/sdkMessage` to us as method `claude/sdkMessage`.
        let params = serde_json::value::RawValue::from_string(
            r#"{"type":"system","subtype":"init"}"#.into(),
        )
        .unwrap();
        let n = ExtNotification::new("claude/sdkMessage", Arc::from(params));
        let (kind, data) = ext_event(&n);
        assert_eq!(kind, "_claude/sdkMessage");
        assert_eq!(data, json!({ "type": "system", "subtype": "init" }));

        let mut live = Live::new("m".into());
        assert_eq!(live.event(kind, data), 0);
        assert!(matches!(&live.parts[0], Part::Event { kind, .. } if kind == "_claude/sdkMessage"));
    }

    #[test]
    fn updates_outside_a_reply_are_stored_and_announced() {
        let (ctx, mut rx) = test_ctx();
        let p = ctx.store.create_project("demo", "/tmp/demo").unwrap();
        let t = ctx.store.create_task(Some(&p.id), "chat").unwrap();
        let conn = Connection {
            ctx: ctx.clone(),
            task_id: t.id.clone(),
            agent: "claude".into(),
            cwd: "/tmp/demo".into(),
            live: Arc::default(),
            options: Arc::default(),
            loading: Arc::default(),
        };
        conn.on_update(SessionUpdate::AvailableCommandsUpdate(
            AvailableCommandsUpdate::new(vec![AvailableCommand::new("init", "Start")]),
        ));
        let events = ctx.store.list_events(&t.id).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "available_commands_update");
        assert_eq!(events[0].agent, "claude");
        assert_eq!(events[0].data["availableCommands"][0]["name"], "init");
        let line = next_line(&mut rx);
        assert_eq!(line["method"], "chat.event");
        assert_eq!(line["params"], json!(events[0]));

        // An extension notification outside a reply lands there too.
        let params = serde_json::value::RawValue::from_string(r#"{"n":1}"#.into()).unwrap();
        conn.on_ext(ExtNotification::new("codex/status", Arc::from(params)));
        let events = ctx.store.list_events(&t.id).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].kind, "_codex/status");
        assert_eq!(events[1].data, json!({ "n": 1 }));
        assert_eq!(next_line(&mut rx)["method"], "chat.event");

        // With a reply in flight the same updates become parts of it instead.
        *conn.live.lock().unwrap() = Some(Live::new("m".into()));
        conn.on_update(SessionUpdate::UsageUpdate(UsageUpdate::new(1, 2)));
        let params = serde_json::value::RawValue::from_string(r#"{"n":2}"#.into()).unwrap();
        conn.on_ext(ExtNotification::new("codex/status", Arc::from(params)));
        assert_eq!(ctx.store.list_events(&t.id).unwrap().len(), 2);
        let line = next_line(&mut rx);
        assert_eq!(line["method"], "chat.update");
        assert_eq!(line["params"]["part_index"], 0);
        assert_eq!(line["params"]["part"]["kind"], "usage_update");
        let line = next_line(&mut rx);
        assert_eq!(line["params"]["part_index"], 1);
        assert_eq!(line["params"]["part"]["kind"], "_codex/status");
        assert_eq!(line["params"]["part"]["data"]["n"], 2);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn official_artifact_result_is_followed_by_a_normalized_chat_event() {
        let (ctx, mut rx) = test_ctx();
        let p = ctx.store.create_project("demo", "/tmp/demo").unwrap();
        let t = ctx.store.create_task(Some(&p.id), "chat").unwrap();
        let conn = Connection {
            ctx,
            task_id: t.id,
            agent: "claude".into(),
            cwd: "/tmp/demo".into(),
            live: Arc::new(Mutex::new(Some(Live::new("m".into())))),
            options: Arc::default(),
            loading: Arc::default(),
        };
        conn.on_update(SessionUpdate::ToolCall(
            ToolCall::new("tool-1", "Publish artifact")
                .raw_input(json!({ "file_path": "/tmp/report.html" }))
                .meta(Meta::from_iter([(
                    "claudeCode".into(),
                    json!({ "toolName": "Artifact" }),
                )])),
        ));
        assert_eq!(next_line(&mut rx)["params"]["part_index"], 0);

        let payload = json!({
            "sessionId": "session-1",
            "message": {
                "type": "user",
                "message": { "content": [{
                    "type": "tool_result",
                    "tool_use_id": "tool-1",
                    "content": "Published prose is not inspected"
                }]},
                "tool_use_result": {
                    "url": "https://claude.ai/code/artifact/abc",
                    "path": "/tmp/report.html",
                    "artifact_id": "abc",
                    "title": "Report",
                    "updated": false
                }
            }
        });
        let params = serde_json::value::RawValue::from_string(payload.to_string()).unwrap();
        conn.on_ext(ExtNotification::new("claude/sdkMessage", Arc::from(params)));

        let raw = next_line(&mut rx);
        assert_eq!(raw["params"]["part_index"], 1);
        assert_eq!(raw["params"]["part"]["kind"], "_claude/sdkMessage");
        let normalized = next_line(&mut rx);
        assert_eq!(normalized["params"]["part_index"], 2);
        assert_eq!(normalized["params"]["part"]["kind"], "artifact.created");
        assert_eq!(
            normalized["params"]["part"]["data"]["artifact"]["id"],
            "abc"
        );
        assert_eq!(
            normalized["params"]["part"]["data"]["artifact"]["path"],
            "/tmp/report.html"
        );
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn transcript_replayed_by_session_load_is_not_stored_again() {
        let (ctx, mut rx) = test_ctx();
        let p = ctx.store.create_project("demo", "/tmp/demo").unwrap();
        let t = ctx.store.create_task(Some(&p.id), "chat").unwrap();
        let conn = Connection {
            ctx: ctx.clone(),
            task_id: t.id.clone(),
            agent: "claude".into(),
            cwd: "/tmp/demo".into(),
            live: Arc::default(),
            options: Arc::default(),
            loading: Arc::default(),
        };

        // While session/load is in flight, the replayed transcript is neither stored
        // nor announced.
        conn.loading.store(true, Ordering::SeqCst);
        conn.on_update(SessionUpdate::AgentMessageChunk(chunk("replayed")));
        conn.on_update(SessionUpdate::UserMessageChunk(chunk("asked")));
        conn.on_update(SessionUpdate::ToolCall(ToolCall::new("tc1", "ls")));
        assert!(ctx.store.list_events(&t.id).unwrap().is_empty());
        assert!(rx.try_recv().is_err());

        // Other updates that arrive during the load are still kept.
        conn.on_update(SessionUpdate::AvailableCommandsUpdate(
            AvailableCommandsUpdate::new(vec![AvailableCommand::new("init", "Start")]),
        ));
        let events = ctx.store.list_events(&t.id).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "available_commands_update");
        let line = next_line(&mut rx);
        assert_eq!(line["method"], "chat.event");
        assert_eq!(line["params"], json!(events[0]));

        // Once the load has resolved, a chunk outside a reply is stored as before.
        conn.loading.store(false, Ordering::SeqCst);
        conn.on_update(SessionUpdate::AgentMessageChunk(chunk("later")));
        let events = ctx.store.list_events(&t.id).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].kind, "agent_message_chunk");
        assert_eq!(events[1].data["content"]["text"], "later");
        assert_eq!(next_line(&mut rx)["method"], "chat.event");
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn permission_requests_carry_the_tool_call_and_meta() {
        let req = RequestPermissionRequest::new(
            "sess",
            ToolCallUpdate::new(
                "tc1",
                ToolCallUpdateFields::new()
                    .title("Write main.rs")
                    .kind(ToolKind::Edit)
                    .content(vec![ToolCallContent::from(Diff::new(
                        "/tmp/demo/main.rs",
                        "new",
                    ))]),
            ),
            vec![
                PermissionOption::new("allow", "Allow", PermissionOptionKind::AllowOnce)
                    .meta(Meta::from_iter([("hotkey".into(), json!("y"))])),
                PermissionOption::new("reject", "Reject", PermissionOptionKind::RejectOnce),
            ],
        )
        .meta(Meta::from_iter([(
            "claude".into(),
            json!({ "suggestions": [] }),
        )]));
        let v = permission_json("req-1", "task", "claude", &req);
        assert_eq!(v["request_id"], "req-1");
        assert_eq!(v["task_id"], "task");
        assert_eq!(v["agent"], "claude");
        assert_eq!(v["title"], "Write main.rs");
        assert_eq!(
            v["options"][0],
            json!({ "id": "allow", "label": "Allow", "kind": "allow_once", "_meta": { "hotkey": "y" } })
        );
        assert_eq!(
            v["options"][1],
            json!({ "id": "reject", "label": "Reject", "kind": "reject_once" })
        );
        assert_eq!(
            v["tool_call"],
            serde_json::to_value(&req.tool_call).unwrap()
        );
        assert_eq!(v["tool_call"]["toolCallId"], "tc1");
        assert_eq!(v["tool_call"]["content"][0]["type"], "diff");
        assert_eq!(v["tool_call"]["content"][0]["newText"], "new");
        assert_eq!(v["_meta"], json!({ "claude": { "suggestions": [] } }));

        let plain = RequestPermissionRequest::new(
            "sess",
            ToolCallUpdate::new("tc2", ToolCallUpdateFields::new()),
            vec![],
        );
        let v = permission_json("req-2", "task", "claude", &plain);
        assert_eq!(v["title"], "tc2");
        assert!(v.get("_meta").is_none());
    }

    #[test]
    fn chat_done_carries_stop_reason_and_usage() {
        let (ctx, mut rx) = test_ctx();
        let p = ctx.store.create_project("demo", "/tmp/demo").unwrap();
        let t = ctx.store.create_task(Some(&p.id), "chat").unwrap();
        let reply = || {
            ctx.store
                .insert_message(&t.id, "assistant", Some("codex"), &[], "streaming")
                .unwrap()
        };

        let a = reply();
        let mut live = Live::new(a.id.clone());
        live.apply(SessionUpdate::AgentMessageChunk(chunk("partial")));
        let usage = Usage::new(12, 10, 2);
        let resp = PromptResponse::new(StopReason::MaxTokens)
            .usage(usage.clone())
            .meta(Meta::from_iter([("x".into(), json!(1))]));
        finish_message(&ctx, &t.id, "codex", live, Ok(resp));
        let m = ctx.store.list_messages(&t.id).unwrap().pop().unwrap();
        assert_eq!(m.status, "done");
        assert_eq!(m.stop_reason.as_deref(), Some("max_tokens"));
        assert_eq!(m.usage, Some(serde_json::to_value(&usage).unwrap()));
        assert_eq!(m.usage.as_ref().unwrap()["totalTokens"], 12);
        let line = next_line(&mut rx);
        assert_eq!(line["method"], "chat.done");
        assert_eq!(line["params"]["message_id"], a.id);
        assert_eq!(line["params"]["status"], "done");
        assert_eq!(line["params"]["stop_reason"], "max_tokens");
        assert_eq!(line["params"]["usage"]["totalTokens"], 12);
        assert_eq!(line["params"]["_meta"]["x"], 1);
        assert!(line["params"].get("error").is_none());

        // Only `cancelled` changes the status; the fields are omitted when not reported.
        let a = reply();
        finish_message(
            &ctx,
            &t.id,
            "codex",
            Live::new(a.id.clone()),
            Ok(PromptResponse::new(StopReason::Cancelled)),
        );
        let m = ctx.store.list_messages(&t.id).unwrap().pop().unwrap();
        assert_eq!(m.status, "cancelled");
        assert_eq!(m.stop_reason.as_deref(), Some("cancelled"));
        assert_eq!(m.usage, None);
        let line = next_line(&mut rx);
        assert_eq!(line["params"]["status"], "cancelled");
        assert_eq!(line["params"]["stop_reason"], "cancelled");
        assert!(line["params"].get("usage").is_none());
        assert!(line["params"].get("_meta").is_none());

        // An error has none of them.
        let a = reply();
        finish_message(
            &ctx,
            &t.id,
            "codex",
            Live::new(a.id.clone()),
            Err("boom".into()),
        );
        let m = ctx.store.list_messages(&t.id).unwrap().pop().unwrap();
        assert_eq!(m.status, "error");
        assert_eq!(m.stop_reason, None);
        assert_eq!(next_line(&mut rx)["method"], "chat.update");
        let line = next_line(&mut rx);
        assert_eq!(line["params"]["status"], "error");
        assert_eq!(line["params"]["error"], "boom");
        assert!(line["params"].get("stop_reason").is_none());
    }

    #[test]
    fn streaming_parts_are_persisted_as_they_arrive() {
        let store = Store::in_memory().unwrap();
        let p = store.create_project("demo", "/tmp/demo").unwrap();
        let t = store.create_task(Some(&p.id), "chat").unwrap();
        let a = store
            .insert_message(&t.id, "assistant", Some("claude"), &[], "streaming")
            .unwrap();
        let stored = || store.list_messages(&t.id).unwrap().pop().unwrap();
        let mut live = Live::new(a.id.clone());

        // Text right after the start is not written yet (at most once per interval)…
        let i = live
            .apply(SessionUpdate::AgentMessageChunk(chunk("hel")))
            .unwrap();
        live.persist(&store, i);
        assert!(stored().parts.is_empty());
        // …a tool call always is, and carries the text along; the status stays streaming.
        let i = live
            .apply(SessionUpdate::ToolCall(ToolCall::new("tc1", "ls")))
            .unwrap();
        live.persist(&store, i);
        assert_eq!(stored().parts.len(), 2);
        assert_eq!(stored().status, "streaming");
        // More text waits for the interval, then goes through.
        let i = live
            .apply(SessionUpdate::AgentMessageChunk(chunk("lo")))
            .unwrap();
        live.persist(&store, i);
        assert_eq!(stored().parts.len(), 2);
        live.last_persisted = Instant::now() - PERSIST_TEXT_EVERY;
        live.persist(&store, i);
        assert!(matches!(&stored().parts[2], Part::Text { text, .. } if text == "lo"));
        // An event always goes through as well.
        let i = live
            .apply(SessionUpdate::UsageUpdate(UsageUpdate::new(1, 2)))
            .unwrap();
        live.persist(&store, i);
        assert_eq!(stored().parts, live.parts);
        // A core that died here leaves the parts; the next start marks the reply cancelled.
        assert_eq!(store.reap_streaming().unwrap(), 1);
        assert_eq!(stored().status, "cancelled");
        assert_eq!(stored().parts, live.parts);
    }

    #[test]
    fn attachments_become_image_and_resource_link_blocks() {
        let parts = vec![
            Part::Text {
                text: "see".into(),
                meta: None,
                message_id: None,
            },
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

    #[test]
    fn rejected_config_value_stays_disabled_across_agent_refreshes() {
        let mut options = Options::default();
        options.set(Some(vec![mode_option("default")]), None);
        options.mark_unavailable(
            "mode",
            &json!("plan"),
            "Plan mode disabled by settings".to_string(),
        );

        let rejected = &options.to_json()[0]["options"][1];
        assert_eq!(rejected["disabled"], true);
        assert_eq!(
            rejected["disabled_reason"],
            "Plan mode disabled by settings"
        );
        assert!(options.to_json()[0]["options"][0].get("disabled").is_none());

        // Agents often send a fresh list after a config change. The local rejection
        // remains attached until a new connection creates a fresh Options value.
        options.set(Some(vec![mode_option("default")]), None);
        assert_eq!(options.to_json()[0]["options"][1]["disabled"], true);

        options.clear_unavailable("mode", &json!("plan"));
        assert!(options.to_json()[0]["options"][1].get("disabled").is_none());
    }

    #[test]
    fn only_definitive_config_rejections_disable_a_value() {
        assert!(is_definitive_config_rejection(
            "Cannot set permission mode to auto: auto mode disabled by settings"
        ));
        assert!(is_definitive_config_rejection(
            "This mode is not supported by the agent"
        ));
        assert!(!is_definitive_config_rejection(SET_CONFIG_TIMED_OUT));
        assert!(!is_definitive_config_rejection("agent exited"));
        assert!(!is_definitive_config_rejection("Internal error"));
    }

    #[test]
    fn protocol_error_prefers_actionable_details() {
        let error = agent_client_protocol::Error::new(-32603, "Internal error")
            .data(json!({ "details": "Cannot set permission mode to auto: auto mode disabled by settings" }));
        assert_eq!(
            error_text(&error),
            "Cannot set permission mode to auto: auto mode disabled by settings"
        );
    }
}
