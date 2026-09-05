//! A native worker owns one provider session. Core remains the sole Chat store.
use super::*;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[derive(Clone, Debug, Deserialize)]
pub struct RuntimeSpec {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;
struct NativeClient {
    tx: mpsc::UnboundedSender<Value>,
    pending: Pending,
    closed: tokio::sync::watch::Receiver<bool>,
}
impl NativeClient {
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = new_id();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        if *self.closed.borrow() {
            self.pending.lock().unwrap().remove(&id);
            return Err("native runtime exited".into());
        }
        if self
            .tx
            .send(json!({"id": id, "method": method, "params": params}))
            .is_err()
        {
            self.pending.lock().unwrap().remove(&id);
            return Err("native runtime exited".into());
        }
        rx.await.map_err(|_| "native runtime exited".to_string())?
    }
}

impl Connection {
    pub(super) async fn run_native(
        &self,
        spec: &RuntimeSpec,
        commands: &mut mpsc::UnboundedReceiver<Command>,
        cancels: &mut mpsc::UnboundedReceiver<()>,
    ) -> Result<(), String> {
        let mut child = tokio::process::Command::new(&spec.command)
            .args(&spec.args)
            .envs(&spec.env)
            .current_dir(&self.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| e.to_string())?;
        let mut stdin = child.stdin.take().unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
        let pending: Pending = Arc::default();
        let (closed_tx, closed) = tokio::sync::watch::channel(false);
        let writer = tokio::spawn(async move {
            while let Some(value) = rx.recv().await {
                if stdin
                    .write_all(format!("{value}\n").as_bytes())
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        let client = NativeClient {
            tx: tx.clone(),
            pending: pending.clone(),
            closed: closed.clone(),
        };
        let updates = self.clone();
        let requests: Arc<Mutex<HashMap<String, String>>> = Arc::default();
        let pending_requests = requests.clone();
        let reader = tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(v) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let id = v["id"].as_str();
                if let Some(method) = v["method"].as_str() {
                    let p = v["params"].clone();
                    if let Some(id) = id {
                        let key = new_id();
                        let (answer, reply) = oneshot::channel();
                        updates.ctx.register_elicitation(key.clone(), answer);
                        pending_requests
                            .lock()
                            .unwrap()
                            .insert(id.to_string(), key.clone());
                        let mut p = p;
                        p["request_id"] = json!(key);
                        p["task_id"] = json!(updates.task_id);
                        p["agent"] = json!(updates.agent);
                        updates.ctx.out.request(&key, method, p);
                        let tx = tx.clone();
                        let id = id.to_string();
                        let ctx = updates.ctx.clone();
                        let keys = pending_requests.clone();
                        tokio::spawn(async move {
                            let result = reply
                                .await
                                .unwrap_or(json!({"action":"cancel", "option_id":null}));
                            ctx.forget_elicitation(&key);
                            keys.lock().unwrap().remove(&id);
                            let _ = tx.send(json!({"id":id,"result":result}));
                        });
                    } else {
                        if method == "runtime.request.cancelled" {
                            let key = pending_requests
                                .lock()
                                .unwrap()
                                .remove(p["id"].as_str().unwrap_or(""));
                            if let Some(key) = key {
                                updates.ctx.forget_elicitation(&key);
                                updates.ctx.out.notify(
                                    "runtime.request.closed",
                                    json!({"request_id":key,"task_id":updates.task_id}),
                                );
                            }
                            continue;
                        }
                        updates.on_native(method, p);
                    }
                } else if let Some(id) = id {
                    if let Some(reply) = pending.lock().unwrap().remove(id) {
                        let result = if v.get("error").is_some() {
                            Err(v["error"]["message"]
                                .as_str()
                                .unwrap_or("native runtime error")
                                .into())
                        } else {
                            Ok(v["result"].clone())
                        };
                        let _ = reply.send(result);
                    }
                }
            }
            let _ = closed_tx.send(true);
            pending.lock().unwrap().clear();
        });
        let mut closed = closed;
        let mut queued = VecDeque::new();
        let result = tokio::select! {
            result = self.serve_native(&client, commands, cancels, &mut queued) => result,
            _ = closed.changed() => Err("native runtime exited".to_string()),
        };
        for job in queued {
            self.finish(
                self.new_live(job.assistant_message_id),
                Err("native runtime exited before queued message could run".into()),
            );
        }
        for (_, key) in requests.lock().unwrap().drain() {
            self.ctx.forget_elicitation(&key);
            self.ctx.out.notify(
                "runtime.request.closed",
                json!({"request_id": key, "task_id": self.task_id}),
            );
        }
        // EOF lets the worker close the SDK/App Server and its child processes first.
        writer.abort();
        if tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
        reader.abort();
        result
    }

    async fn serve_native(
        &self,
        client: &NativeClient,
        commands: &mut mpsc::UnboundedReceiver<Command>,
        cancels: &mut mpsc::UnboundedReceiver<()>,
        queued: &mut VecDeque<Job>,
    ) -> Result<(), String> {
        // ACP adapter IDs are not assumed to be native provider IDs. Migrating to a
        // native session replays the canonical Chat through the existing Handoff.
        let key = format!("{}:native-v1", self.agent);
        let saved = self
            .ctx
            .store
            .session_id(&self.task_id, &key)
            .map_err(|e| e.to_string())?;
        let configs = self
            .ctx
            .store
            .config_values(&self.task_id, &self.agent)
            .map_err(|e| e.to_string())?;
        let opened = tokio::time::timeout(
            Duration::from_secs(90),
            client.request(
                "session.open",
                json!({"taskId":self.task_id,"cwd":self.cwd,"sessionId":saved,"config":configs}),
            ),
        )
        .await
        .map_err(|_| "native runtime startup timed out".to_string())??;
        let session = opened["sessionId"]
            .as_str()
            .ok_or("runtime returned no session ID")?;
        self.ctx
            .store
            .begin_session(&self.task_id, &key, session, saved.is_none())
            .map_err(|e| e.to_string())?;
        self.status("ready", None);
        loop {
            let cmd = if let Some(job) = queued.pop_front() {
                Some(Command::Prompt(job))
            } else {
                commands.recv().await
            };
            let Some(cmd) = cmd else {
                return Ok(());
            };
            match cmd {
                Command::Prompt(job) => {
                    while cancels.try_recv().is_ok() {}
                    let input = self.build_prompt_for(&job, &key)?;
                    let mut live = Live::new(job.assistant_message_id);
                    live.cursor_agent = Some(key.clone());
                    *self.live.lock().unwrap() = Some(live);
                    let prompt = client.request("turn.start", json!({"input":input}));
                    tokio::pin!(prompt);
                    let mut cancel_deadline: Option<tokio::time::Instant> = None;
                    let result = loop {
                        tokio::select! {
                            result = &mut prompt => break result,
                            Some(()) = cancels.recv() => {
                                if let Some(l) = self.live.lock().unwrap().as_mut() { l.cancelled = true; }
                                // Cancellation must not await a response on the prompt reader.
                                let _ = client.tx.send(json!({"method":"turn.cancel","params":{}}));
                                cancel_deadline.get_or_insert_with(|| tokio::time::Instant::now() + Duration::from_secs(15));
                            },
                            _ = async {
                                if let Some(deadline) = cancel_deadline { tokio::time::sleep_until(deadline).await; }
                                else { std::future::pending::<()>().await; }
                            } => return Err("native runtime did not acknowledge cancellation; session closed".into()),
                            cmd = commands.recv() => match cmd {
                                Some(Command::Prompt(job)) => queued.push_back(job),
                                Some(Command::SetConfig{reply,..}) => { let _ = reply.send(Err("Wait for the active message to finish before changing runtime settings".into())); },
                                Some(Command::Announce) => { self.status("ready",None); self.emit_config(); },
                                None => return Err("task closed".into()),
                            }
                        }
                    };
                    if let Some(live) = self.live.lock().unwrap().take() {
                        self.finish(
                            live,
                            result.and_then(|v| {
                                serde_json::from_value::<PromptResponse>(v)
                                    .map_err(|e| e.to_string())
                            }),
                        );
                    }
                }
                Command::SetConfig {
                    config_id,
                    value,
                    reply,
                } => {
                    let result = tokio::time::timeout(
                        Duration::from_secs(25),
                        client.request("session.configure", json!({"id":config_id,"value":value})),
                    )
                    .await
                    .map_err(|_| "native runtime configuration timed out".to_string())
                    .and_then(|r| r)
                    .map(|_| ());
                    if result.is_ok() {
                        let _ = self.ctx.store.set_config_value(
                            &self.task_id,
                            &self.agent,
                            &config_id,
                            &value,
                        );
                    }
                    let _ = reply.send(result);
                }
                Command::Announce => {
                    self.status("ready", None);
                    self.emit_config();
                }
            }
        }
    }

    fn on_native(&self, method: &str, p: Value) {
        match method {
            "runtime.config" => {
                if let Ok(config) = serde_json::from_value(p["options"].clone()) {
                    self.lock_options().config = config;
                    self.emit_config();
                }
            }
            "runtime.part" => {
                let Ok(part) = serde_json::from_value::<Part>(p["part"].clone()) else {
                    self.store_event("runtime.invalid_part", p);
                    return;
                };
                let mut guard = self.live.lock().unwrap();
                if let Some(live) = guard.as_mut() {
                    let key = p["key"].as_str().unwrap_or("").to_string();
                    let index = if let Some(index) = live.tools.get(&key).copied() {
                        live.parts[index] = part;
                        index
                    } else {
                        let i = live.parts.len();
                        live.parts.push(part);
                        live.tools.insert(key, i);
                        i
                    };
                    self.changed(live, index);
                } else {
                    drop(guard);
                    self.store_event("runtime.part", p);
                }
            }
            "runtime.event" => {
                let kind = p["type"].as_str().unwrap_or("provider.unknown");
                if matches!(
                    kind,
                    "available_commands_update" | "session.capabilities" | "session.skills"
                ) {
                    self.store_event(kind, p["data"].clone());
                    return;
                }
                // Append raw envelopes to the event log; never copy every token envelope
                // into the Message JSON (quadratic writes on long messages).
                if kind == "provider.raw" {
                    if let Err(e) =
                        self.ctx
                            .store
                            .insert_event(&self.task_id, &self.agent, kind, p.clone())
                    {
                        warn!("persist runtime event: {e:#}");
                    }
                } else {
                    let mut guard = self.live.lock().unwrap();
                    if let Some(live) = guard.as_mut() {
                        let events = if kind == "_claude/sdkMessage" {
                            crate::artifacts::from_adapter_event(kind, &p["data"], &live.parts)
                        } else {
                            vec![]
                        };
                        let index = live.event(kind.into(), p["data"].clone());
                        self.changed(live, index);
                        for (kind, data) in events {
                            let index = live.event(kind, data);
                            self.changed(live, index);
                        }
                    } else {
                        drop(guard);
                        self.store_event(kind, p["data"].clone());
                    }
                }
            }
            _ => self.store_event(method, p),
        }
    }
}
