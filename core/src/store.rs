//! SQLite transcript store: Projects, Tasks, Messages, and per-(task, agent) cursors.

use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Part {
    Text {
        text: String,
    },
    Thought {
        text: String,
    },
    ToolCall {
        id: String,
        title: String,
        kind: String,
        status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<String>,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub task_id: String,
    pub role: String,
    pub agent: Option<String>,
    pub parts: Vec<Part>,
    pub created_at: String,
    pub status: String,
}

pub fn new_id() -> String {
    ulid::Ulid::new().to_string()
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
    role TEXT NOT NULL, agent TEXT, parts TEXT NOT NULL, status TEXT NOT NULL,
    created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id);
CREATE TABLE IF NOT EXISTS agent_cursors (
    task_id TEXT NOT NULL, agent TEXT NOT NULL, last_seen_message_index INTEGER NOT NULL,
    PRIMARY KEY (task_id, agent));
";

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path).with_context(|| format!("open {}", path.display()))?;
        Self::init(conn)
    }

    #[cfg(test)]
    pub fn in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        Ok(f(&conn)?)
    }

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        self.with(|c| {
            c.prepare("SELECT id, name, path, created_at FROM projects ORDER BY rowid")?
                .query_map([], |r| {
                    Ok(Project {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        path: r.get(2)?,
                        created_at: r.get(3)?,
                    })
                })?
                .collect()
        })
    }

    pub fn create_project(&self, name: &str, path: &str) -> Result<Project> {
        let p = Project {
            id: new_id(),
            name: name.to_string(),
            path: path.to_string(),
            created_at: now(),
        };
        self.with(|c| {
            c.execute(
                "INSERT INTO projects (id, name, path, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![p.id, p.name, p.path, p.created_at],
            )
        })?;
        Ok(p)
    }

    pub fn get_project(&self, id: &str) -> Result<Option<Project>> {
        self.with(|c| {
            c.query_row(
                "SELECT id, name, path, created_at FROM projects WHERE id = ?1",
                [id],
                |r| {
                    Ok(Project {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        path: r.get(2)?,
                        created_at: r.get(3)?,
                    })
                },
            )
            .optional()
        })
    }

    pub fn list_tasks(&self, project_id: &str) -> Result<Vec<Task>> {
        self.with(|c| {
            c.prepare(
                "SELECT id, project_id, title, created_at FROM tasks WHERE project_id = ?1 ORDER BY rowid",
            )?
            .query_map([project_id], |r| {
                Ok(Task {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    title: r.get(2)?,
                    created_at: r.get(3)?,
                })
            })?
            .collect()
        })
    }

    pub fn create_task(&self, project_id: &str, title: &str) -> Result<Task> {
        let t = Task {
            id: new_id(),
            project_id: project_id.to_string(),
            title: title.to_string(),
            created_at: now(),
        };
        self.with(|c| {
            c.execute(
                "INSERT INTO tasks (id, project_id, title, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![t.id, t.project_id, t.title, t.created_at],
            )
        })?;
        Ok(t)
    }

    pub fn get_task(&self, id: &str) -> Result<Option<Task>> {
        self.with(|c| {
            c.query_row(
                "SELECT id, project_id, title, created_at FROM tasks WHERE id = ?1",
                [id],
                |r| {
                    Ok(Task {
                        id: r.get(0)?,
                        project_id: r.get(1)?,
                        title: r.get(2)?,
                        created_at: r.get(3)?,
                    })
                },
            )
            .optional()
        })
    }

    /// Full transcript of a Task in insertion order.
    pub fn list_messages(&self, task_id: &str) -> Result<Vec<Message>> {
        self.with(|c| {
            c.prepare(
                "SELECT id, task_id, role, agent, parts, status, created_at FROM messages \
                 WHERE task_id = ?1 ORDER BY rowid",
            )?
            .query_map([task_id], |r| {
                let parts: String = r.get(4)?;
                Ok(Message {
                    id: r.get(0)?,
                    task_id: r.get(1)?,
                    role: r.get(2)?,
                    agent: r.get(3)?,
                    parts: serde_json::from_str(&parts).unwrap_or_default(),
                    status: r.get(5)?,
                    created_at: r.get(6)?,
                })
            })?
            .collect()
        })
    }

    pub fn insert_message(
        &self,
        task_id: &str,
        role: &str,
        agent: Option<&str>,
        parts: &[Part],
        status: &str,
    ) -> Result<Message> {
        let m = Message {
            id: new_id(),
            task_id: task_id.to_string(),
            role: role.to_string(),
            agent: agent.map(str::to_string),
            parts: parts.to_vec(),
            created_at: now(),
            status: status.to_string(),
        };
        let parts_json = serde_json::to_string(&m.parts)?;
        self.with(|c| {
            c.execute(
                "INSERT INTO messages (id, task_id, role, agent, parts, status, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    m.id,
                    m.task_id,
                    m.role,
                    m.agent,
                    parts_json,
                    m.status,
                    m.created_at
                ],
            )
        })?;
        Ok(m)
    }

    pub fn finish_message(&self, id: &str, parts: &[Part], status: &str) -> Result<()> {
        let parts_json = serde_json::to_string(parts)?;
        self.with(|c| {
            c.execute(
                "UPDATE messages SET parts = ?1, status = ?2 WHERE id = ?3",
                params![parts_json, status, id],
            )
        })?;
        Ok(())
    }

    /// Index of the last transcript message this agent has seen, or -1 if none.
    pub fn cursor(&self, task_id: &str, agent: &str) -> Result<i64> {
        self.with(|c| {
            c.query_row(
                "SELECT last_seen_message_index FROM agent_cursors WHERE task_id = ?1 AND agent = ?2",
                [task_id, agent],
                |r| r.get(0),
            )
            .optional()
            .map(|v| v.unwrap_or(-1))
        })
    }

    pub fn set_cursor(&self, task_id: &str, agent: &str, index: i64) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO agent_cursors (task_id, agent, last_seen_message_index) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(task_id, agent) DO UPDATE SET last_seen_message_index = excluded.last_seen_message_index",
                params![task_id, agent, index],
            )
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(s: &str) -> Vec<Part> {
        vec![Part::Text { text: s.into() }]
    }

    #[test]
    fn projects_tasks_roundtrip() {
        let s = Store::in_memory().unwrap();
        let p = s.create_project("demo", "/tmp/demo").unwrap();
        assert_eq!(s.list_projects().unwrap().len(), 1);
        assert_eq!(s.get_project(&p.id).unwrap().unwrap().path, "/tmp/demo");
        let t = s.create_task(&p.id, "first").unwrap();
        assert_eq!(s.list_tasks(&p.id).unwrap()[0].id, t.id);
        assert!(s.get_task("missing").unwrap().is_none());
    }

    #[test]
    fn messages_keep_order_and_parts() {
        let s = Store::in_memory().unwrap();
        let p = s.create_project("demo", "/tmp/demo").unwrap();
        let t = s.create_task(&p.id, "first").unwrap();
        let u = s
            .insert_message(&t.id, "user", Some("claude"), &text("hi"), "done")
            .unwrap();
        let a = s
            .insert_message(&t.id, "assistant", Some("claude"), &[], "streaming")
            .unwrap();
        let parts = vec![
            Part::Thought { text: "hmm".into() },
            Part::ToolCall {
                id: "tc1".into(),
                title: "ls".into(),
                kind: "execute".into(),
                status: "completed".into(),
                output: Some("a b".into()),
            },
            Part::Text {
                text: "hello".into(),
            },
        ];
        s.finish_message(&a.id, &parts, "done").unwrap();
        let history = s.list_messages(&t.id).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].id, u.id);
        assert_eq!(history[1].parts, parts);
        assert_eq!(history[1].status, "done");
        let json = serde_json::to_value(&history[1].parts[1]).unwrap();
        assert_eq!(json["type"], "tool_call");
        assert_eq!(json["output"], "a b");
    }

    #[test]
    fn cursor_defaults_and_upserts() {
        let s = Store::in_memory().unwrap();
        assert_eq!(s.cursor("t", "claude").unwrap(), -1);
        s.set_cursor("t", "claude", 3).unwrap();
        assert_eq!(s.cursor("t", "claude").unwrap(), 3);
        s.set_cursor("t", "claude", 5).unwrap();
        assert_eq!(s.cursor("t", "claude").unwrap(), 5);
        assert_eq!(s.cursor("t", "codex").unwrap(), -1);
    }
}
