//! openyak-core: transcript store + ACP client, spoken to over stdio JSON-RPC.

mod agents;
mod handoff;
mod rpc;
mod store;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use clap::Parser;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};
use tracing::{error, warn};

use agents::AgentPool;
use rpc::Outbound;
use store::Store;

#[derive(Parser)]
#[command(
    name = "openyak-core",
    about = "OpenYak core: transcript store and ACP client"
)]
struct Args {
    /// Directory holding openyak.db; created if missing.
    #[arg(long)]
    data_dir: PathBuf,
}

/// Everything shared between request handlers and agent connections.
pub struct Ctx {
    pub store: Store,
    pub out: Outbound,
    pub agents: AgentPool,
    /// Neutral workspace used by Chats that are not attached to a Project.
    pub projectless_dir: String,
    permissions: Mutex<HashMap<String, oneshot::Sender<Option<String>>>>,
}

impl Ctx {
    pub fn register_permission(&self, request_id: String, tx: oneshot::Sender<Option<String>>) {
        self.permissions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(request_id, tx);
    }

    pub fn forget_permission(&self, request_id: &str) {
        self.permissions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(request_id);
    }

    /// Deliver the app's answer; false if no such request is pending.
    pub fn resolve_permission(&self, request_id: &str, option_id: Option<String>) -> bool {
        let tx = self
            .permissions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(request_id);
        match tx {
            Some(tx) => tx.send(option_id).is_ok(),
            None => false,
        }
    }
}

fn main() -> Result<()> {
    // Claude Code refuses to start when it thinks it is nested inside another Claude Code
    // session. Core hosting an adapter is not a nested session, so drop the marker before
    // any thread exists (env mutation is only safe while single-threaded).
    std::env::remove_var("CLAUDECODE");
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run())
}

async fn run() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();

    let args = Args::parse();
    std::fs::create_dir_all(&args.data_dir)
        .with_context(|| format!("create {}", args.data_dir.display()))?;
    let projectless_dir = args.data_dir.join("projectless");
    std::fs::create_dir_all(&projectless_dir)
        .with_context(|| format!("create {}", projectless_dir.display()))?;
    let store = Store::open(&args.data_dir.join("openyak.db"))?;

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(mut line) = out_rx.recv().await {
            line.push('\n');
            if stdout.write_all(line.as_bytes()).await.is_err() || stdout.flush().await.is_err() {
                break;
            }
        }
    });

    let ctx = Arc::new(Ctx {
        store,
        out: Outbound(out_tx),
        agents: AgentPool::default(),
        projectless_dir: projectless_dir.to_string_lossy().into_owned(),
        permissions: Mutex::default(),
    });

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                ctx.out
                    .respond_error(Value::Null, -32700, &format!("parse error: {e}"));
                continue;
            }
        };
        handle_line(&ctx, msg);
    }

    // stdin closed: the app is gone. Give the writer a moment to flush, then stop;
    // dropping the runtime drops the agent connections, which kills the adapters.
    drop(ctx);
    let _ = tokio::time::timeout(std::time::Duration::from_millis(200), writer).await;
    Ok(())
}

fn handle_line(ctx: &Arc<Ctx>, msg: Value) {
    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    if let Some(method) = msg.get("method").and_then(Value::as_str) {
        let params = msg
            .get("params")
            .cloned()
            .unwrap_or(Value::Object(Default::default()));
        if id.is_null() {
            warn!(method, "ignoring notification");
            return;
        }
        tokio::spawn(rpc::dispatch(ctx.clone(), id, method.to_string(), params));
    } else if msg.get("result").is_some() || msg.get("error").is_some() {
        // A JSON-RPC response to a core → app request (permission.request).
        let Some(request_id) = id.as_str() else {
            error!("response with non-string id: {msg}");
            return;
        };
        let option_id = msg
            .get("result")
            .and_then(|r| r.get("option_id"))
            .and_then(Value::as_str)
            .map(str::to_string);
        if !ctx.resolve_permission(request_id, option_id) {
            warn!(request_id, "response for unknown request");
        }
    } else {
        ctx.out.respond_error(id, -32600, "invalid request");
    }
}
