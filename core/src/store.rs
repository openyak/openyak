//! SQLite transcript store: Projects, Tasks, Messages, and the per-(task, agent) runtime
//! state that makes agent switching work: the transcript cursor, the native ACP session id,
//! and the config values the user picked.

use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    pub project_id: Option<String>,
    pub title: String,
    pub created_at: String,
    /// Last time a Message was added or finished; what the app sorts Tasks by.
    pub updated_at: String,
    /// Messages in the Chat. Zero means a chat that has not started (a draft).
    pub message_count: i64,
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
    /// An image attached to a user Message, base64-encoded.
    Image {
        mime_type: String,
        data: String,
    },
    /// A file or folder attached to a user Message, by path.
    File {
        path: String,
        name: String,
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
    id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id),
    title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
    role TEXT NOT NULL, agent TEXT, parts TEXT NOT NULL, status TEXT NOT NULL,
    created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id);
CREATE TABLE IF NOT EXISTS agent_cursors (
    task_id TEXT NOT NULL, agent TEXT NOT NULL, last_seen_message_index INTEGER NOT NULL,
    PRIMARY KEY (task_id, agent));
CREATE TABLE IF NOT EXISTS agent_sessions (
    task_id TEXT NOT NULL, agent TEXT NOT NULL, session_id TEXT NOT NULL,
    PRIMARY KEY (task_id, agent));
CREATE TABLE IF NOT EXISTS agent_config (
    task_id TEXT NOT NULL, agent TEXT NOT NULL, config_id TEXT NOT NULL, value TEXT NOT NULL,
    PRIMARY KEY (task_id, agent, config_id));
";

pub struct Store {
    conn: Mutex<Connection>,
}

/// Bring a database created by an earlier core up to the current schema.
fn migrate(conn: &Connection) -> Result<()> {
    let has_updated_at = conn
        .prepare("PRAGMA table_info(tasks)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(Result::ok)
        .any(|name| name == "updated_at");
    if !has_updated_at {
        conn.execute_batch(
            "ALTER TABLE tasks ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
             UPDATE tasks SET updated_at = created_at WHERE updated_at = '';",
        )?;
    }

    let project_id_is_required = conn
        .prepare("PRAGMA table_info(tasks)")?
        .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, i64>(3)?)))?
        .filter_map(Result::ok)
        .any(|(name, not_null)| name == "project_id" && not_null != 0);
    if project_id_is_required {
        // SQLite cannot remove a NOT NULL constraint in place. Foreign keys are disabled
        // only for the table rebuild; the replacement keeps the same parent relationship.
        conn.execute_batch(
            "PRAGMA foreign_keys=OFF;
             BEGIN IMMEDIATE;
             CREATE TABLE tasks_new (
                 id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id),
                 title TEXT NOT NULL, created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL DEFAULT '');
             INSERT INTO tasks_new (id, project_id, title, created_at, updated_at)
                 SELECT id, project_id, title, created_at, updated_at FROM tasks;
             DROP TABLE tasks;
             ALTER TABLE tasks_new RENAME TO tasks;
             COMMIT;
             PRAGMA foreign_keys=ON;",
        )?;
    }
    Ok(())
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
        migrate(&conn)?;
        let store = Self {
            conn: Mutex::new(conn),
        };
        store.reap_streaming()?;
        store.purge_empty_tasks()?;
        Ok(store)
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        Ok(f(&conn)?)
    }

    /// A Message still `streaming` when core starts belonged to a previous process; nothing
    /// will ever finish it, so mark it cancelled rather than leave it live forever.
    pub fn reap_streaming(&self) -> Result<usize> {
        self.with(|c| {
            c.execute(
                "UPDATE messages SET status = 'cancelled' WHERE status = 'streaming'",
                [],
            )
        })
    }

    /// Tasks that never got a message belong to a previous run's unsent new chat; drop
    /// them (and their agent state) so they do not pile up.
    pub fn purge_empty_tasks(&self) -> Result<usize> {
        self.with(|c| {
            const EMPTY: &str =
                "SELECT id FROM tasks WHERE id NOT IN (SELECT task_id FROM messages)";
            for table in ["agent_cursors", "agent_sessions", "agent_config"] {
                c.execute(
                    &format!("DELETE FROM {table} WHERE task_id IN ({EMPTY})"),
                    [],
                )?;
            }
            c.execute(&format!("DELETE FROM tasks WHERE id IN ({EMPTY})"), [])
        })
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

    /// Rename a Project without changing its folder path.
    pub fn rename_project(&self, id: &str, name: &str) -> Result<Option<Project>> {
        self.with(|c| {
            c.execute(
                "UPDATE projects SET name = ?1 WHERE id = ?2",
                params![name, id],
            )
        })?;
        self.get_project(id)
    }

    /// Update the editable Project fields; None if it does not exist.
    pub fn update_project(&self, id: &str, name: &str, path: &str) -> Result<Option<Project>> {
        self.with(|c| {
            c.execute(
                "UPDATE projects SET name = ?1, path = ?2 WHERE id = ?3",
                params![name, path, id],
            )
        })?;
        self.get_project(id)
    }

    /// Delete a Project, all of its Tasks and Chats, and their agent state.
    pub fn delete_project(&self, id: &str) -> Result<bool> {
        self.with(|c| {
            const TASKS: &str = "SELECT id FROM tasks WHERE project_id = ?1";
            for table in [
                "agent_cursors",
                "agent_sessions",
                "agent_config",
                "messages",
            ] {
                c.execute(
                    &format!("DELETE FROM {table} WHERE task_id IN ({TASKS})"),
                    [id],
                )?;
            }
            c.execute("DELETE FROM tasks WHERE project_id = ?1", [id])?;
            Ok(c.execute("DELETE FROM projects WHERE id = ?1", [id])? > 0)
        })
    }

    /// Tasks of a Project (or projectless Tasks), most recently updated first.
    pub fn list_tasks(&self, project_id: Option<&str>) -> Result<Vec<Task>> {
        self.with(|c| {
            c.prepare(
                "SELECT id, project_id, title, created_at, updated_at, \
                 (SELECT COUNT(*) FROM messages m WHERE m.task_id = t.id) \
                 FROM tasks t WHERE project_id = ?1 OR (project_id IS NULL AND ?1 IS NULL) \
                 ORDER BY updated_at DESC, rowid DESC",
            )?
            .query_map([project_id], |r| {
                Ok(Task {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    title: r.get(2)?,
                    created_at: r.get(3)?,
                    updated_at: r.get(4)?,
                    message_count: r.get(5)?,
                })
            })?
            .collect()
        })
    }

    pub fn create_task(&self, project_id: Option<&str>, title: &str) -> Result<Task> {
        let created_at = now();
        let t = Task {
            id: new_id(),
            project_id: project_id.map(str::to_string),
            title: title.to_string(),
            updated_at: created_at.clone(),
            created_at,
            message_count: 0,
        };
        self.with(|c| {
            c.execute(
                "INSERT INTO tasks (id, project_id, title, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![t.id, t.project_id, t.title, t.created_at, t.updated_at],
            )
        })?;
        Ok(t)
    }

    pub fn get_task(&self, id: &str) -> Result<Option<Task>> {
        self.with(|c| {
            c.query_row(
                "SELECT id, project_id, title, created_at, updated_at, \
                 (SELECT COUNT(*) FROM messages m WHERE m.task_id = t.id) \
                 FROM tasks t WHERE id = ?1",
                [id],
                |r| {
                    Ok(Task {
                        id: r.get(0)?,
                        project_id: r.get(1)?,
                        title: r.get(2)?,
                        created_at: r.get(3)?,
                        updated_at: r.get(4)?,
                        message_count: r.get(5)?,
                    })
                },
            )
            .optional()
        })
    }

    /// Retitle a Task; None if it does not exist. Does not count as activity.
    pub fn rename_task(&self, id: &str, title: &str) -> Result<Option<Task>> {
        self.with(|c| {
            c.execute(
                "UPDATE tasks SET title = ?1 WHERE id = ?2",
                params![title, id],
            )
        })?;
        self.get_task(id)
    }

    /// Delete a Task with its Chat and agent state; false if it did not exist.
    pub fn delete_task(&self, id: &str) -> Result<bool> {
        self.with(|c| {
            for table in [
                "agent_cursors",
                "agent_sessions",
                "agent_config",
                "messages",
            ] {
                c.execute(&format!("DELETE FROM {table} WHERE task_id = ?1"), [id])?;
            }
            Ok(c.execute("DELETE FROM tasks WHERE id = ?1", [id])? > 0)
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
            )?;
            c.execute(
                "UPDATE tasks SET updated_at = ?1 WHERE id = ?2",
                params![m.created_at, m.task_id],
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
            )?;
            c.execute(
                "UPDATE tasks SET updated_at = ?1 \
                 WHERE id = (SELECT task_id FROM messages WHERE id = ?2)",
                params![now(), id],
            )
        })?;
        Ok(())
    }

    /// Remove `message_id` and everything after it from a Task's transcript.
    ///
    /// Replaying an earlier turn must not resume an ACP session that still remembers the
    /// discarded suffix, so session ids and cursors are cleared in the same transaction.
    /// User-selected config is intentionally kept and will be applied to the fresh session.
    pub fn truncate_messages_from(&self, task_id: &str, message_id: &str) -> Result<bool> {
        let changed_at = now();
        self.with(|c| {
            let rowid: Option<i64> = c
                .query_row(
                    "SELECT rowid FROM messages WHERE id = ?1 AND task_id = ?2",
                    params![message_id, task_id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(rowid) = rowid else {
                return Ok(false);
            };

            c.execute_batch("BEGIN IMMEDIATE")?;
            let result = (|| {
                c.execute(
                    "DELETE FROM messages WHERE task_id = ?1 AND rowid >= ?2",
                    params![task_id, rowid],
                )?;
                c.execute("DELETE FROM agent_cursors WHERE task_id = ?1", [task_id])?;
                c.execute("DELETE FROM agent_sessions WHERE task_id = ?1", [task_id])?;
                c.execute(
                    "UPDATE tasks SET updated_at = ?1 WHERE id = ?2",
                    params![changed_at, task_id],
                )?;
                Ok::<(), rusqlite::Error>(())
            })();
            match result {
                Ok(()) => {
                    c.execute_batch("COMMIT")?;
                    Ok(true)
                }
                Err(e) => {
                    let _ = c.execute_batch("ROLLBACK");
                    Err(e)
                }
            }
        })
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

    /// The native ACP session id last used for `(task, agent)`, if any.
    pub fn session_id(&self, task_id: &str, agent: &str) -> Result<Option<String>> {
        self.with(|c| {
            c.query_row(
                "SELECT session_id FROM agent_sessions WHERE task_id = ?1 AND agent = ?2",
                [task_id, agent],
                |r| r.get(0),
            )
            .optional()
        })
    }

    /// Record the ACP session now serving `(task, agent)`. A `fresh` session has no memory
    /// of the Chat, so the cursor is reset: the next prompt carries the whole transcript.
    /// A resumed session keeps its cursor.
    pub fn begin_session(
        &self,
        task_id: &str,
        agent: &str,
        session_id: &str,
        fresh: bool,
    ) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO agent_sessions (task_id, agent, session_id) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(task_id, agent) DO UPDATE SET session_id = excluded.session_id",
                params![task_id, agent, session_id],
            )
        })?;
        if fresh {
            self.set_cursor(task_id, agent, -1)?;
        }
        Ok(())
    }

    /// Config values the user picked for `(task, agent)`, in the order they were first set.
    pub fn config_values(&self, task_id: &str, agent: &str) -> Result<Vec<(String, Value)>> {
        self.with(|c| {
            c.prepare(
                "SELECT config_id, value FROM agent_config WHERE task_id = ?1 AND agent = ?2 ORDER BY rowid",
            )?
            .query_map([task_id, agent], |r| {
                let id: String = r.get(0)?;
                let raw: String = r.get(1)?;
                Ok((id, serde_json::from_str(&raw).unwrap_or(Value::Null)))
            })?
            .collect()
        })
    }

    pub fn set_config_value(
        &self,
        task_id: &str,
        agent: &str,
        config_id: &str,
        value: &Value,
    ) -> Result<()> {
        let raw = serde_json::to_string(value)?;
        self.with(|c| {
            c.execute(
                "INSERT INTO agent_config (task_id, agent, config_id, value) VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(task_id, agent, config_id) DO UPDATE SET value = excluded.value",
                params![task_id, agent, config_id, raw],
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
        let t = s.create_task(Some(&p.id), "first").unwrap();
        assert_eq!(s.list_tasks(Some(&p.id)).unwrap()[0].id, t.id);
        assert_eq!(t.updated_at, t.created_at);
        assert_eq!(t.message_count, 0);
        assert!(s.get_task("missing").unwrap().is_none());
    }

    #[test]
    fn projectless_tasks_roundtrip_separately_from_project_tasks() {
        let s = Store::in_memory().unwrap();
        let p = s.create_project("demo", "/tmp/demo").unwrap();
        let project_task = s.create_task(Some(&p.id), "in project").unwrap();
        let projectless_task = s.create_task(None, "no project").unwrap();

        assert_eq!(projectless_task.project_id, None);
        assert_eq!(s.list_tasks(None).unwrap()[0].id, projectless_task.id);
        assert_eq!(s.list_tasks(Some(&p.id)).unwrap()[0].id, project_task.id);
    }

    #[test]
    fn projects_can_be_renamed_and_deleted_with_their_tasks() {
        let s = Store::in_memory().unwrap();
        let p = s.create_project("demo", "/tmp/demo").unwrap();
        let t = s.create_task(Some(&p.id), "chat").unwrap();
        s.insert_message(&t.id, "user", Some("codex"), &text("hi"), "done")
            .unwrap();
        s.begin_session(&t.id, "codex", "session", true).unwrap();

        let renamed = s.rename_project(&p.id, "renamed").unwrap().unwrap();
        assert_eq!(renamed.name, "renamed");
        assert_eq!(renamed.path, p.path);
        assert!(s.rename_project("missing", "x").unwrap().is_none());

        let updated = s
            .update_project(&p.id, "moved", "/tmp/moved")
            .unwrap()
            .unwrap();
        assert_eq!(updated.name, "moved");
        assert_eq!(updated.path, "/tmp/moved");
        assert!(s
            .update_project("missing", "x", "/tmp/x")
            .unwrap()
            .is_none());

        assert!(s.delete_project(&p.id).unwrap());
        assert!(!s.delete_project(&p.id).unwrap());
        assert!(s.get_project(&p.id).unwrap().is_none());
        assert!(s.get_task(&t.id).unwrap().is_none());
        assert!(s.list_messages(&t.id).unwrap().is_empty());
        assert!(s.session_id(&t.id, "codex").unwrap().is_none());
    }

    #[test]
    fn tasks_count_messages_and_can_be_renamed_and_deleted() {
        let s = Store::in_memory().unwrap();
        let p = s.create_project("demo", "/tmp/demo").unwrap();
        let t = s.create_task(Some(&p.id), "New chat").unwrap();
        s.insert_message(&t.id, "user", Some("codex"), &text("hi"), "done")
            .unwrap();
        s.insert_message(&t.id, "assistant", Some("codex"), &[], "streaming")
            .unwrap();
        assert_eq!(s.get_task(&t.id).unwrap().unwrap().message_count, 2);
        assert_eq!(s.list_tasks(Some(&p.id)).unwrap()[0].message_count, 2);

        let renamed = s.rename_task(&t.id, "say hi").unwrap().unwrap();
        assert_eq!(renamed.title, "say hi");
        assert!(renamed.updated_at >= t.updated_at);
        assert!(s.rename_task("missing", "x").unwrap().is_none());

        s.set_cursor(&t.id, "codex", 1).unwrap();
        s.begin_session(&t.id, "codex", "sess", true).unwrap();
        s.set_config_value(&t.id, "codex", "model", &Value::from("m"))
            .unwrap();
        assert!(s.delete_task(&t.id).unwrap());
        assert!(!s.delete_task(&t.id).unwrap());
        assert!(s.get_task(&t.id).unwrap().is_none());
        assert!(s.list_messages(&t.id).unwrap().is_empty());
        assert_eq!(s.cursor(&t.id, "codex").unwrap(), -1);
        assert!(s.session_id(&t.id, "codex").unwrap().is_none());
        assert!(s.config_values(&t.id, "codex").unwrap().is_empty());
    }

    #[test]
    fn empty_tasks_are_purged_on_open() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL);
             CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '');
             CREATE TABLE messages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), role TEXT NOT NULL, agent TEXT, parts TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
             CREATE TABLE agent_sessions (task_id TEXT NOT NULL, agent TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY (task_id, agent));
             INSERT INTO projects VALUES ('p', 'demo', '/tmp/demo', '2026-01-01T00:00:00.000Z');
             INSERT INTO tasks VALUES ('kept', 'p', 'kept', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
             INSERT INTO tasks VALUES ('empty', 'p', 'New chat', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z');
             INSERT INTO messages VALUES ('m', 'kept', 'user', 'codex', '[]', 'done', '2026-01-02T00:00:01.000Z');
             INSERT INTO agent_sessions VALUES ('empty', 'codex', 'sess');",
        )
        .unwrap();
        let s = Store::init(conn).unwrap();
        let ids: Vec<String> = s
            .list_tasks(Some("p"))
            .unwrap()
            .into_iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(ids, ["kept"]);
        assert!(s.session_id("empty", "codex").unwrap().is_none());
    }

    #[test]
    fn tasks_list_most_recently_updated_first() {
        let s = Store::in_memory().unwrap();
        let p = s.create_project("demo", "/tmp/demo").unwrap();
        let a = s.create_task(Some(&p.id), "a").unwrap();
        let b = s.create_task(Some(&p.id), "b").unwrap();
        // Newest first when nothing has happened yet.
        let ids: Vec<String> = s
            .list_tasks(Some(&p.id))
            .unwrap()
            .into_iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(ids, [b.id.clone(), a.id.clone()]);
        // A message in `a` makes it the most recent, and the change is visible on the Task.
        std::thread::sleep(std::time::Duration::from_millis(2));
        s.insert_message(&a.id, "user", Some("codex"), &text("hi"), "done")
            .unwrap();
        let listed = s.list_tasks(Some(&p.id)).unwrap();
        assert_eq!(listed[0].id, a.id);
        assert!(listed[0].updated_at > listed[0].created_at);
        // Finishing a reply bumps it too.
        let reply = s
            .insert_message(&b.id, "assistant", Some("codex"), &[], "streaming")
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        s.finish_message(&reply.id, &text("done"), "done").unwrap();
        assert_eq!(s.list_tasks(Some(&p.id)).unwrap()[0].id, b.id);
    }

    #[test]
    fn old_databases_gain_updated_at() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL);
             CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, created_at TEXT NOT NULL);
             CREATE TABLE messages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), role TEXT NOT NULL, agent TEXT, parts TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
             INSERT INTO projects VALUES ('p', 'demo', '/tmp/demo', '2026-01-01T00:00:00.000Z');
             INSERT INTO tasks VALUES ('t', 'p', 'old', '2026-01-02T00:00:00.000Z');
             INSERT INTO messages VALUES ('m', 't', 'user', 'codex', '[]', 'done', '2026-01-02T00:00:01.000Z');",
        )
        .unwrap();
        let s = Store::init(conn).unwrap();
        let t = s.get_task("t").unwrap().unwrap();
        assert_eq!(t.updated_at, "2026-01-02T00:00:00.000Z");
        assert_eq!(t.message_count, 1);
        assert_eq!(s.list_tasks(Some("p")).unwrap().len(), 1);

        let projectless = s.create_task(None, "no project").unwrap();
        assert_eq!(projectless.project_id, None);
        assert_eq!(s.list_tasks(None).unwrap()[0].id, projectless.id);
        assert!(s.create_task(Some("missing"), "invalid").is_err());
    }

    #[test]
    fn messages_keep_order_and_parts() {
        let s = Store::in_memory().unwrap();
        let p = s.create_project("demo", "/tmp/demo").unwrap();
        let t = s.create_task(Some(&p.id), "first").unwrap();
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
    fn streaming_messages_are_reaped_on_open() {
        let s = Store::in_memory().unwrap();
        let p = s.create_project("demo", "/tmp/demo").unwrap();
        let t = s.create_task(Some(&p.id), "first").unwrap();
        s.insert_message(&t.id, "user", Some("claude"), &text("hi"), "done")
            .unwrap();
        s.insert_message(
            &t.id,
            "assistant",
            Some("claude"),
            &text("par"),
            "streaming",
        )
        .unwrap();
        assert_eq!(s.reap_streaming().unwrap(), 1);
        let history = s.list_messages(&t.id).unwrap();
        assert_eq!(history[0].status, "done");
        assert_eq!(history[1].status, "cancelled");
        assert_eq!(history[1].parts, text("par"));
        assert_eq!(s.reap_streaming().unwrap(), 0);
    }

    #[test]
    fn truncating_a_transcript_clears_runtime_but_keeps_config() {
        let s = Store::in_memory().unwrap();
        let p = s.create_project("demo", "/tmp/demo").unwrap();
        let t = s.create_task(Some(&p.id), "first").unwrap();
        let first = s
            .insert_message(&t.id, "user", Some("codex"), &text("one"), "done")
            .unwrap();
        let reply = s
            .insert_message(&t.id, "assistant", Some("codex"), &text("two"), "done")
            .unwrap();
        s.insert_message(&t.id, "user", Some("codex"), &text("three"), "done")
            .unwrap();
        s.begin_session(&t.id, "codex", "sess", false).unwrap();
        s.set_cursor(&t.id, "codex", 2).unwrap();
        s.set_config_value(&t.id, "codex", "model", &Value::from("gpt"))
            .unwrap();

        assert!(s.truncate_messages_from(&t.id, &reply.id).unwrap());
        assert_eq!(
            s.list_messages(&t.id)
                .unwrap()
                .into_iter()
                .map(|m| m.id)
                .collect::<Vec<_>>(),
            [first.id]
        );
        assert!(s.session_id(&t.id, "codex").unwrap().is_none());
        assert_eq!(s.cursor(&t.id, "codex").unwrap(), -1);
        assert_eq!(
            s.config_values(&t.id, "codex").unwrap(),
            vec![("model".to_string(), Value::from("gpt"))]
        );
        assert!(!s.truncate_messages_from(&t.id, "missing").unwrap());
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

    #[test]
    fn fresh_session_resets_cursor_resumed_keeps_it() {
        let s = Store::in_memory().unwrap();
        assert!(s.session_id("t", "claude").unwrap().is_none());
        s.set_cursor("t", "claude", 4).unwrap();

        s.begin_session("t", "claude", "sess-1", true).unwrap();
        assert_eq!(
            s.session_id("t", "claude").unwrap().as_deref(),
            Some("sess-1")
        );
        assert_eq!(s.cursor("t", "claude").unwrap(), -1);

        s.set_cursor("t", "claude", 6).unwrap();
        s.begin_session("t", "claude", "sess-1", false).unwrap();
        assert_eq!(s.cursor("t", "claude").unwrap(), 6);

        s.begin_session("t", "claude", "sess-2", true).unwrap();
        assert_eq!(
            s.session_id("t", "claude").unwrap().as_deref(),
            Some("sess-2")
        );
        assert_eq!(s.cursor("t", "claude").unwrap(), -1);
        assert!(s.session_id("t", "codex").unwrap().is_none());
    }

    #[test]
    fn config_values_upsert_and_keep_first_set_order() {
        let s = Store::in_memory().unwrap();
        assert!(s.config_values("t", "codex").unwrap().is_empty());
        s.set_config_value("t", "codex", "model", &Value::from("gpt-5.5"))
            .unwrap();
        s.set_config_value("t", "codex", "fast-mode", &Value::from(true))
            .unwrap();
        s.set_config_value("t", "codex", "model", &Value::from("gpt-5.4"))
            .unwrap();
        assert_eq!(
            s.config_values("t", "codex").unwrap(),
            vec![
                ("model".to_string(), Value::from("gpt-5.4")),
                ("fast-mode".to_string(), Value::from(true)),
            ]
        );
        assert!(s.config_values("t", "claude").unwrap().is_empty());
    }
}
