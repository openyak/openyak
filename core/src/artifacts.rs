//! Provider artifact outputs normalized at the ACP ingress boundary.
//!
//! Claude's public Agent SDK exposes `ArtifactInput` / `ArtifactOutput`, while ACP does
//! not yet define an Artifact session update. `claude-agent-acp` can forward the public
//! SDK message containing `tool_use_result`; this module translates that one structured
//! provider envelope into provider-neutral `artifact.*` events. The raw SDK event remains
//! in the Chat beside the normalized event, so no provider data is discarded.

use serde_json::{json, Map, Value};

use crate::store::Part;

const CLAUDE_SDK_MESSAGE: &str = "_claude/sdkMessage";
const ARTIFACT_TOOL: &str = "Artifact";

fn object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn string_field(source: &Map<String, Value>, key: &str, target: &mut Map<String, Value>) {
    if let Some(value) = source.get(key).and_then(Value::as_str) {
        target.insert(key.to_string(), json!(value));
    }
}

fn copied_field(
    source: &Map<String, Value>,
    source_key: &str,
    target_key: &str,
    target: &mut Map<String, Value>,
) {
    if let Some(value) = source.get(source_key) {
        target.insert(target_key.to_string(), value.clone());
    }
}

fn artifact_reference(output: &Map<String, Value>) -> Value {
    let mut artifact = Map::new();
    copied_field(output, "artifact_id", "id", &mut artifact);
    for key in ["url", "path", "title", "version", "contract", "audience"] {
        string_field(output, key, &mut artifact);
    }
    copied_field(output, "capabilities", "capabilities", &mut artifact);
    copied_field(
        output,
        "liveSubscription",
        "live_subscription",
        &mut artifact,
    );
    Value::Object(artifact)
}

fn listed_artifact(value: &Value) -> Option<Value> {
    let source = object(value)?;
    let mut artifact = Map::new();
    for key in ["url", "title", "favicon"] {
        string_field(source, key, &mut artifact);
    }
    copied_field(source, "updatedAt", "updated_at", &mut artifact);
    copied_field(source, "rel", "relation", &mut artifact);
    Some(Value::Object(artifact))
}

fn provider_meta(output: &Value) -> Value {
    json!({
        "source": "claude-agent-sdk",
        "provider_payload": output,
    })
}

fn event(
    kind: &str,
    operation: &str,
    tool_call_id: &str,
    body: Value,
    output: &Value,
) -> (String, Value) {
    let mut data = match body {
        Value::Object(value) => value,
        _ => Map::new(),
    };
    data.insert("schema_version".into(), json!(1));
    data.insert("tool_call_id".into(), json!(tool_call_id));
    data.insert("operation".into(), json!(operation));
    data.insert("_meta".into(), provider_meta(output));
    (kind.to_string(), Value::Object(data))
}

fn normalized_output(tool_call_id: &str, input: &Value, output: &Value) -> (String, Value) {
    let action = input
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("publish");
    let Some(value) = object(output) else {
        return event(
            "artifact.operation.completed",
            action,
            tool_call_id,
            json!({}),
            output,
        );
    };

    if value.get("url").and_then(Value::as_str).is_some()
        && value.get("path").and_then(Value::as_str).is_some()
    {
        let kind = if value.get("updated").and_then(Value::as_bool) == Some(true) {
            "artifact.updated"
        } else {
            "artifact.created"
        };
        return event(
            kind,
            "publish",
            tool_call_id,
            json!({ "artifact": artifact_reference(value), "warnings": value.get("warnings") }),
            output,
        );
    }

    if let Some(artifacts) = value.get("artifacts").and_then(Value::as_array) {
        return event(
            "artifact.listed",
            "list",
            tool_call_id,
            json!({
                "artifacts": artifacts.iter().filter_map(listed_artifact).collect::<Vec<_>>(),
                "truncated": value.get("truncated"),
                "scope": value.get("scope"),
            }),
            output,
        );
    }

    if let Some(read) = value.get("read").and_then(Value::as_object) {
        return event(
            "artifact.read",
            "read",
            tool_call_id,
            json!({
                "artifact": { "url": read.get("url") },
                "bytes": read.get("bytes"),
                "status": read.get("code"),
                "duration_ms": read.get("durationMs"),
            }),
            output,
        );
    }

    if let Some(watch) = value.get("watch").and_then(Value::as_object) {
        return event(
            "artifact.watch.updated",
            "watch",
            tool_call_id,
            json!({
                "artifact": { "url": watch.get("url") },
                "watching": watch.get("watching"),
                "outcome": watch.get("outcome"),
            }),
            output,
        );
    }

    if let Some(unwatch) = value.get("unwatch").and_then(Value::as_object) {
        return event(
            "artifact.watch.updated",
            "unwatch",
            tool_call_id,
            json!({
                "artifact": { "url": unwatch.get("url") },
                "watching": false,
                "was_watching": unwatch.get("was_watching"),
            }),
            output,
        );
    }

    if let Some(watches) = value.get("watches") {
        return event(
            "artifact.watches.listed",
            "status",
            tool_call_id,
            json!({ "watches": watches, "filter_url": value.get("filter_url"), "arms": value.get("arms") }),
            output,
        );
    }

    for (field, kind, operation) in [
        ("asset_upload", "artifact.asset.created", "upload_asset"),
        ("asset_list", "artifact.assets.listed", "list_assets"),
        ("asset_read", "artifact.asset.read", "read_asset"),
        ("asset_delete", "artifact.asset.deleted", "delete_asset"),
    ] {
        if let Some(asset) = value.get(field) {
            let artifact = asset
                .get("url")
                .and_then(Value::as_str)
                .map(|url| json!({ "url": url }));
            return event(
                kind,
                operation,
                tool_call_id,
                json!({ "artifact": artifact, "asset": asset }),
                output,
            );
        }
    }

    event(
        "artifact.operation.completed",
        action,
        tool_call_id,
        json!({}),
        output,
    )
}

fn artifact_tool<'a>(parts: &'a [Part], tool_call_id: &str) -> Option<&'a Value> {
    parts.iter().find_map(|part| match part {
        Part::ToolCall {
            id,
            raw_input,
            meta,
            ..
        } if id == tool_call_id
            && meta
                .as_ref()
                .and_then(|value| value.get("claudeCode"))
                .and_then(|value| value.get("toolName"))
                .and_then(Value::as_str)
                == Some(ARTIFACT_TOOL) =>
        {
            raw_input.as_ref()
        }
        _ => None,
    })
}

/// Convert one official Claude SDK Artifact tool result into a common event.
///
/// The SDK message is selected through the adapter's public `emitRawSDKMessages` option.
/// No prose, Markdown, code fence, or display title is parsed.
pub fn from_adapter_event(kind: &str, data: &Value, parts: &[Part]) -> Vec<(String, Value)> {
    if kind != CLAUDE_SDK_MESSAGE {
        return vec![];
    }
    let Some(message) = data.get("message") else {
        return vec![];
    };
    if message.get("type").and_then(Value::as_str) != Some("user") {
        return vec![];
    }
    let Some(output) = message.get("tool_use_result") else {
        return vec![];
    };
    let Some(content) = message
        .get("message")
        .and_then(|value| value.get("content"))
        .and_then(Value::as_array)
    else {
        return vec![];
    };

    let candidates: Vec<(&str, &Value)> = content
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
        .filter(|block| block.get("is_error").and_then(Value::as_bool) != Some(true))
        .filter_map(|block| block.get("tool_use_id").and_then(Value::as_str))
        .filter_map(|id| artifact_tool(parts, id).map(|input| (id, input)))
        .collect();

    // `tool_use_result` is message-level and has no id. The public adapter documents
    // that it can only be attributed when exactly one matching tool result is present.
    if let [(tool_call_id, input)] = candidates.as_slice() {
        vec![normalized_output(tool_call_id, input, output)]
    } else {
        vec![]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn artifact_call() -> Part {
        Part::ToolCall {
            id: "tool-1".into(),
            title: "Publish artifact".into(),
            kind: "other".into(),
            status: "pending".into(),
            output: None,
            content: None,
            locations: None,
            raw_input: Some(json!({ "file_path": "/tmp/report.html" })),
            raw_output: None,
            meta: Some(Map::from_iter([(
                "claudeCode".into(),
                json!({ "toolName": "Artifact" }),
            )])),
        }
    }

    #[test]
    fn normalizes_public_sdk_publish_output_without_reading_prose() {
        let data = json!({
            "sessionId": "session-1",
            "message": {
                "type": "user",
                "message": { "content": [{
                    "type": "tool_result",
                    "tool_use_id": "tool-1",
                    "content": "This prose is intentionally not parseable."
                }]},
                "tool_use_result": {
                    "url": "https://claude.ai/code/artifact/abc",
                    "path": "/tmp/report.html",
                    "artifact_id": "abc",
                    "title": "Quarterly report",
                    "version": "v2",
                    "updated": true,
                    "liveSubscription": "connected"
                }
            }
        });
        let events = from_adapter_event(CLAUDE_SDK_MESSAGE, &data, &[artifact_call()]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "artifact.updated");
        assert_eq!(events[0].1["artifact"]["id"], "abc");
        assert_eq!(events[0].1["artifact"]["path"], "/tmp/report.html");
        assert_eq!(events[0].1["artifact"]["live_subscription"], "connected");
        assert_eq!(events[0].1["operation"], "publish");
    }

    #[test]
    fn ignores_lookalike_results_from_non_artifact_tools() {
        let mut call = artifact_call();
        if let Part::ToolCall { meta, .. } = &mut call {
            *meta = Some(Map::from_iter([(
                "claudeCode".into(),
                json!({ "toolName": "Other" }),
            )]));
        }
        let data = json!({
            "message": {
                "type": "user",
                "message": { "content": [{ "type": "tool_result", "tool_use_id": "tool-1" }] },
                "tool_use_result": { "url": "https://example.com", "path": "/tmp/file" }
            }
        });
        assert!(from_adapter_event(CLAUDE_SDK_MESSAGE, &data, &[call]).is_empty());
    }
}
