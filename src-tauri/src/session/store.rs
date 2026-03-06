use super::SessionRecord;
use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub created_at: String,
    pub updated_at: String,
    pub status: String,
    pub title: String,
    pub domain: String,
    pub complexity: String,
    pub consented_to_dataset: bool,
    pub problem_preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetExportResult {
    pub path: String,
    pub count: u32,
}

pub fn save_session(record: &SessionRecord) -> Result<String, String> {
    let connection = open_connection()?;
    let payload = record
        .export_json()
        .map_err(|err| format!("failed to serialize session: {err}"))?;
    let created_at = record.metadata.timestamp.to_rfc3339();
    let updated_at = record
        .updated_at
        .clone()
        .unwrap_or_else(|| created_at.clone());
    let requirement = session_problem_statement(record);
    let status = session_status(record);
    let title = session_title(record);
    let problem_preview = session_problem_preview(record);

    connection
        .execute(
            r#"
            INSERT OR REPLACE INTO sessions (
              id,
              created_at,
              updated_at,
              status,
              title,
              problem_preview,
              domain,
              complexity,
              consented_to_dataset,
              requirement,
              payload
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            "#,
            params![
                record.id.to_string(),
                created_at,
                updated_at,
                status,
                title,
                problem_preview,
                &record.metadata.domain,
                &record.metadata.complexity,
                if record.metadata.consented_to_dataset {
                    1
                } else {
                    0
                },
                requirement,
                payload,
            ],
        )
        .map_err(|err| format!("failed to save session: {err}"))?;

    Ok(record.id.to_string())
}

pub fn list_sessions(limit: usize) -> Result<Vec<SessionSummary>, String> {
    let connection = open_connection()?;
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, created_at, updated_at, status, title, domain, complexity, consented_to_dataset, problem_preview, payload
            FROM sessions
            ORDER BY updated_at DESC
            LIMIT ?1
            "#,
        )
        .map_err(|err| format!("failed to prepare list query: {err}"))?;

    let rows = statement
        .query_map(params![limit as i64], |row| {
            let payload: String = row.get(9)?;
            let parsed = serde_json::from_str::<SessionRecord>(&payload).ok();
            let fallback_title = parsed
                .as_ref()
                .map(session_title)
                .unwrap_or_else(|| "Untitled draft".to_string());
            let fallback_preview = parsed
                .as_ref()
                .map(session_problem_preview)
                .unwrap_or_default();
            let fallback_status = parsed
                .as_ref()
                .map(session_status)
                .unwrap_or_else(|| "draft".to_string());

            Ok(SessionSummary {
                id: row.get(0)?,
                created_at: row.get(1)?,
                updated_at: row.get::<_, String>(2)?,
                status: {
                    let status: String = row.get(3)?;
                    if status.trim().is_empty() {
                        fallback_status
                    } else {
                        status
                    }
                },
                title: {
                    let title: String = row.get(4)?;
                    if title.trim().is_empty() {
                        fallback_title
                    } else {
                        title
                    }
                },
                domain: row.get(5)?,
                complexity: row.get(6)?,
                consented_to_dataset: row.get::<_, i64>(7)? == 1,
                problem_preview: {
                    let preview: String = row.get(8)?;
                    if preview.trim().is_empty() {
                        fallback_preview
                    } else {
                        preview
                    }
                },
            })
        })
        .map_err(|err| format!("failed to query sessions: {err}"))?;

    let mut sessions = Vec::new();
    for row in rows {
        sessions.push(row.map_err(|err| format!("failed to map session row: {err}"))?);
    }

    Ok(sessions)
}

pub fn load_session(id: &str) -> Result<Option<SessionRecord>, String> {
    let connection = open_connection()?;
    let mut statement = connection
        .prepare("SELECT payload FROM sessions WHERE id = ?1")
        .map_err(|err| format!("failed to prepare load query: {err}"))?;

    let payload_result = statement.query_row(params![id], |row| row.get::<_, String>(0));
    match payload_result {
        Ok(payload) => {
            let record: SessionRecord = serde_json::from_str(&payload)
                .map_err(|err| format!("failed to decode session payload: {err}"))?;
            Ok(Some(record))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(format!("failed to load session: {err}")),
    }
}

pub fn export_consented_dataset(
    target_path: Option<String>,
) -> Result<DatasetExportResult, String> {
    let connection = open_connection()?;
    let output_path = target_path
        .map(PathBuf::from)
        .unwrap_or_else(default_dataset_path);

    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "failed to create dataset export directory {:?}: {err}",
                parent
            )
        })?;
    }

    let mut statement = connection
        .prepare(
            r#"
            SELECT payload
            FROM sessions
            WHERE consented_to_dataset = 1
            ORDER BY created_at ASC
            "#,
        )
        .map_err(|err| format!("failed to prepare dataset export query: {err}"))?;

    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| format!("failed to query dataset export rows: {err}"))?;

    let mut lines: Vec<String> = Vec::new();
    for row in rows {
        lines.push(row.map_err(|err| format!("failed to read dataset row: {err}"))?);
    }

    let mut payload = lines.join("\n");
    if !payload.is_empty() {
        payload.push('\n');
    }

    fs::write(&output_path, payload)
        .map_err(|err| format!("failed to write dataset export {:?}: {err}", output_path))?;

    Ok(DatasetExportResult {
        path: output_path.to_string_lossy().to_string(),
        count: lines.len() as u32,
    })
}

fn open_connection() -> Result<Connection, String> {
    let db_path = database_path()?;
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create friction data directory: {err}"))?;
    }

    let connection =
        Connection::open(db_path).map_err(|err| format!("failed to open sqlite: {err}"))?;
    init_schema(&connection)?;

    Ok(connection)
}

fn init_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS sessions (
              id TEXT PRIMARY KEY,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL DEFAULT '',
              status TEXT NOT NULL DEFAULT '',
              title TEXT NOT NULL DEFAULT '',
              problem_preview TEXT NOT NULL DEFAULT '',
              domain TEXT NOT NULL,
              complexity TEXT NOT NULL,
              consented_to_dataset INTEGER NOT NULL,
              requirement TEXT NOT NULL,
              payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
            "#,
        )
        .map_err(|err| format!("failed to initialize sqlite schema: {err}"))?;

    ensure_column(
        connection,
        "sessions",
        "updated_at",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(connection, "sessions", "status", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(connection, "sessions", "title", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(
        connection,
        "sessions",
        "problem_preview",
        "TEXT NOT NULL DEFAULT ''",
    )?;

    connection
        .execute(
            r#"
            UPDATE sessions
            SET updated_at = created_at
            WHERE updated_at IS NULL OR updated_at = ''
            "#,
            [],
        )
        .map_err(|err| format!("failed to backfill updated_at: {err}"))?;

    Ok(())
}

fn database_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("unable to locate home directory")?;
    Ok(home.join(".friction").join("sessions.db"))
}

fn default_dataset_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let stamp = Utc::now().format("%Y%m%d-%H%M%S");
    home.join(".friction")
        .join("exports")
        .join(format!("friction-dataset-{stamp}.jsonl"))
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let pragma = format!("PRAGMA table_info({table})");
    let mut statement = connection
        .prepare(&pragma)
        .map_err(|err| format!("failed to inspect sqlite schema: {err}"))?;
    let column_names = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|err| format!("failed to enumerate sqlite columns: {err}"))?;

    for name in column_names {
        let existing = name.map_err(|err| format!("failed to read sqlite column name: {err}"))?;
        if existing == column {
            return Ok(());
        }
    }

    connection
        .execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
            [],
        )
        .map_err(|err| format!("failed to add sqlite column {column}: {err}"))?;
    Ok(())
}

fn session_problem_statement(record: &SessionRecord) -> String {
    record
        .problem_statement
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| record.requirement.clone())
}

fn session_status(record: &SessionRecord) -> String {
    if let Some(status) = record.status.as_ref().filter(|value| !value.trim().is_empty()) {
        return status.clone();
    }

    if phase3_has_content(record) {
        return "proof_ready".to_string();
    }

    if session_action_brief(record).is_some() || record.phase2.as_ref().is_some() {
        return "brief_ready".to_string();
    }

    if record.phase1.as_ref().is_some() {
        return "friction".to_string();
    }

    if !session_problem_statement(record).trim().is_empty() {
        return "draft".to_string();
    }

    "draft".to_string()
}

fn session_title(record: &SessionRecord) -> String {
    if let Some(title) = record.title.as_ref().filter(|value| !value.trim().is_empty()) {
        return title.clone();
    }

    let problem = session_problem_statement(record);
    if let Some(first_line) = problem
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| truncate(line, 80))
    {
        return first_line;
    }

    if let Some(brief) = session_action_brief(record) {
        if !brief.final_decision.trim().is_empty() {
            return truncate(&brief.final_decision, 80);
        }
    }

    "Untitled draft".to_string()
}

fn session_problem_preview(record: &SessionRecord) -> String {
    let problem = session_problem_statement(record);
    if !problem.trim().is_empty() {
        return truncate(problem.trim(), 140);
    }

    if let Some(brief) = session_action_brief(record) {
        if !brief.problem_frame.trim().is_empty() {
            return truncate(brief.problem_frame.trim(), 140);
        }
        if !brief.final_decision.trim().is_empty() {
            return truncate(brief.final_decision.trim(), 140);
        }
    }

    String::new()
}

fn phase3_has_content(record: &SessionRecord) -> bool {
    let Some(phase3) = record.phase3.as_ref() else {
        return false;
    };
    !phase3.code_a.trim().is_empty()
        || !phase3.code_b.trim().is_empty()
        || !phase3.attack_report.is_empty()
        || phase3.confidence_score > 0.0
}

fn session_action_brief(record: &SessionRecord) -> Option<&super::ExecutionBrief> {
    record
        .result
        .as_ref()
        .and_then(|result| result.action_brief.as_ref().or(result.execution_brief.as_ref()))
        .or_else(|| {
            record.phase2.as_ref().and_then(|phase2| {
                phase2
                    .action_brief
                    .as_ref()
                    .or(phase2.execution_brief.as_ref())
            })
        })
}

fn truncate(value: &str, max_len: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max_len {
        return trimmed.to_string();
    }

    let mut output = String::with_capacity(max_len + 1);
    for ch in trimmed.chars().take(max_len) {
        output.push(ch);
    }
    output.push('…');
    output
}
