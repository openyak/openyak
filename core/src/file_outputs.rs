//! Completed structured file writes, distinct from provider-published Artifacts.
use crate::store::Part;
use serde_json::json;

pub fn from_tool(part: &Part) -> Option<Part> {
    let Part::ToolCall {
        id,
        kind,
        status,
        raw_output,
        raw_input,
        content,
        meta,
        ..
    } = part
    else {
        return None;
    };
    if status != "completed" || kind != "edit" {
        return None;
    }
    let mut paths = Vec::new();
    // Codex App Server's typed FileChange item. Never infer a write from command text.
    if let Some(output) = raw_output
        .as_ref()
        .filter(|v| v["type"] == "fileChange" && v["status"] == "completed")
    {
        if let Some(changes) = output["changes"].as_array() {
            for change in changes {
                match change["kind"]["type"].as_str() {
                    Some("add" | "update") => paths.push(
                        change["kind"]["movePath"]
                            .as_str()
                            .or(change["path"].as_str()),
                    ),
                    _ => {}
                }
            }
        }
    } else if matches!(
        meta.as_ref()
            .and_then(|m| m.get("claudeCode"))
            .and_then(|v| v["toolName"].as_str()),
        Some("Write" | "Edit")
    ) {
        // Official Claude tool identity plus successful result, not its display title.
        paths.push(raw_input.as_ref().and_then(|v| v["file_path"].as_str()));
    } else if let Some(content) = content {
        // ACP's provider-neutral Diff content (null newText denotes deletion).
        for diff in content {
            if diff["type"] == "diff" && diff["newText"].is_string() {
                paths.push(diff["path"].as_str());
            }
        }
    }
    let mut files = Vec::new();
    for path in paths
        .into_iter()
        .flatten()
        .filter(|p| !p.is_empty() && !p.contains('\0'))
    {
        let file = json!({"path":path});
        if !files.contains(&file) {
            files.push(file);
        }
    }
    if files.is_empty() {
        return None;
    }
    Some(Part::Event {
        kind: "file.output".into(),
        data: json!({"schema_version":1,"tool_call_id":id,"files":files}),
    })
}

/// Backfill old terminal transcripts in memory only; preserve stored provider evidence.
pub fn enrich(parts: &mut Vec<Part>) {
    let derived: Vec<_> = parts.iter().filter_map(from_tool).collect();
    for event in derived {
        if !parts.contains(&event) {
            parts.push(event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn call(extra: Value) -> Part {
        let mut value = json!({"type":"tool_call", "id":"write-1", "title":"anything", "kind":"edit", "status":"completed"});
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn successful_codex_report_has_a_file_output_not_an_artifact() {
        let part = call(
            json!({"raw_output":{"type":"fileChange","status":"completed","changes":[
                {"path":"report.md","kind":{"type":"add"}},
                {"path":"old.md","kind":{"type":"delete"}},
                {"path":"before.md","kind":{"type":"update","movePath":"after.md"}}
            ]}}),
        );
        assert_eq!(
            serde_json::to_value(from_tool(&part)).unwrap(),
            json!({
                "type":"event","kind":"file.output","data":{"schema_version":1,"tool_call_id":"write-1","files":[{"path":"report.md"},{"path":"after.md"}]}
            })
        );
    }

    #[test]
    fn claude_write_and_acp_diff_use_structured_fields_only() {
        assert!(from_tool(&call(json!({"_meta":{"claudeCode":{"toolName":"Write"}},"raw_input":{"file_path":"report.md"}}))).is_some());
        assert!(from_tool(&call(
            json!({"content":[{"type":"diff","path":"report.md","newText":"# Report"}]})
        ))
        .is_some());
        for extra in [
            json!({"title":"Write", "raw_input":{"file_path":"report.md"}}),
            json!({"raw_output":{"type":"fileChange","status":"failed","changes":[{"path":"report.md","kind":{"type":"add"}}]}}),
            json!({"status":"failed","content":[{"type":"diff","path":"report.md","newText":"x"}]}),
            json!({"status":"in_progress","content":[{"type":"diff","path":"report.md","newText":"x"}]}),
            json!({"content":[{"type":"diff","path":"report.md","newText":null}]}),
            json!({"kind":"execute","output":"Wrote report.md"}),
        ] {
            assert!(from_tool(&call(extra)).is_none());
        }
    }

    #[test]
    fn backfill_preserves_original_parts_and_is_idempotent() {
        let original = call(
            json!({"_meta":{"claudeCode":{"toolName":"Write"}},"raw_input":{"file_path":"report.md"}}),
        );
        let mut parts = vec![original.clone()];
        enrich(&mut parts);
        enrich(&mut parts);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0], original);
    }
}
