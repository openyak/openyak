//! Handoff: the block of missed Chat turns prepended when a Message goes to an Agent
//! that has not seen them (see docs/architecture.md).

use crate::store::{Message, Part};

/// Messages after `cursor` (the index of the last message the agent saw, -1 if none),
/// excluding `exclude_id` (the user message that is the prompt itself).
pub fn missed<'a>(transcript: &'a [Message], cursor: i64, exclude_id: &str) -> Vec<&'a Message> {
    transcript
        .iter()
        .enumerate()
        .filter(|(i, m)| *i as i64 > cursor && m.id != exclude_id)
        .map(|(_, m)| m)
        .collect()
}

/// Cursor value that marks the whole transcript as seen.
pub fn end_cursor(transcript: &[Message]) -> i64 {
    transcript.len() as i64 - 1
}

pub fn render(missed: &[&Message]) -> String {
    let mut out = String::from(
        "<handoff>\nYou are continuing a task. Earlier turns were handled by another assistant.\n\
         Treat them as the conversation so far.\n\n",
    );
    for m in missed {
        let label = match (m.role.as_str(), m.agent.as_deref()) {
            ("assistant", Some(agent)) => format!("assistant · {agent}"),
            (role, _) => role.to_string(),
        };
        out.push_str(&format!("[{label}] {}\n\n", render_parts(&m.parts)));
    }
    out.push_str("</handoff>");
    out
}

fn render_parts(parts: &[Part]) -> String {
    parts
        .iter()
        .filter_map(|p| match p {
            Part::Text { text } => Some(text.clone()),
            Part::Thought { .. } => None,
            Part::ToolCall { title, .. } => Some(format!("[tool: {title}]")),
            Part::Error { message } => Some(format!("[error: {message}]")),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The full prompt text: handoff block (if any) followed by the user's message.
pub fn build_prompt(transcript: &[Message], cursor: i64, user_message: &Message) -> String {
    let text = render_parts(&user_message.parts);
    let missed = missed(transcript, cursor, &user_message.id);
    if missed.is_empty() {
        text
    } else {
        format!("{}\n\n{text}", render(&missed))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(id: &str, role: &str, agent: Option<&str>, text: &str) -> Message {
        Message {
            id: id.into(),
            task_id: "t".into(),
            role: role.into(),
            agent: agent.map(Into::into),
            parts: vec![Part::Text { text: text.into() }],
            created_at: String::new(),
            status: "done".into(),
        }
    }

    #[test]
    fn fresh_agent_gets_whole_prior_transcript() {
        let transcript = vec![
            msg("u1", "user", Some("codex"), "hello"),
            msg("a1", "assistant", Some("codex"), "hi there"),
            msg("u2", "user", Some("claude"), "continue"),
        ];
        let prompt = build_prompt(&transcript, -1, &transcript[2]);
        assert_eq!(
            prompt,
            "<handoff>\nYou are continuing a task. Earlier turns were handled by another assistant.\n\
             Treat them as the conversation so far.\n\n[user] hello\n\n[assistant · codex] hi there\n\n</handoff>\n\ncontinue"
        );
        assert_eq!(end_cursor(&transcript), 2);
    }

    #[test]
    fn caught_up_agent_gets_plain_text() {
        let transcript = vec![
            msg("u1", "user", Some("claude"), "hello"),
            msg("a1", "assistant", Some("claude"), "hi"),
            msg("u2", "user", Some("claude"), "more"),
        ];
        assert_eq!(build_prompt(&transcript, 1, &transcript[2]), "more");
        assert!(missed(&transcript, 1, "u2").is_empty());
    }

    #[test]
    fn only_turns_after_cursor_are_included() {
        let transcript = vec![
            msg("u1", "user", Some("claude"), "one"),
            msg("a1", "assistant", Some("claude"), "two"),
            msg("u2", "user", Some("codex"), "three"),
            msg("a2", "assistant", Some("codex"), "four"),
            msg("u3", "user", Some("claude"), "five"),
        ];
        let m = missed(&transcript, 1, "u3");
        let ids: Vec<&str> = m.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["u2", "a2"]);
        let prompt = build_prompt(&transcript, 1, &transcript[4]);
        assert!(prompt.contains("[user] three"));
        assert!(prompt.contains("[assistant · codex] four"));
        assert!(!prompt.contains("one"));
        assert!(prompt.ends_with("</handoff>\n\nfive"));
    }

    #[test]
    fn tool_calls_and_errors_are_summarised_thoughts_dropped() {
        let mut m = msg("a1", "assistant", Some("codex"), "done");
        m.parts.insert(
            0,
            Part::Thought {
                text: "secret".into(),
            },
        );
        m.parts.insert(
            1,
            Part::ToolCall {
                id: "1".into(),
                title: "cargo test".into(),
                kind: "execute".into(),
                status: "completed".into(),
                output: None,
            },
        );
        m.parts.push(Part::Error {
            message: "boom".into(),
        });
        let rendered = render(&[&m]);
        assert!(rendered.contains("[assistant · codex] [tool: cargo test]\ndone\n[error: boom]"));
        assert!(!rendered.contains("secret"));
    }
}
