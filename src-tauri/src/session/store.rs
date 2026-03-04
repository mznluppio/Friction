use super::SessionRecord;
use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub created_at: String,
    pub domain: String,
    pub complexity: String,
    pub consented_to_dataset: bool,
    pub requirement_preview: String,
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

    connection
        .execute(
            r#"
            INSERT OR REPLACE INTO sessions (
              id,
              created_at,
              domain,
              complexity,
              consented_to_dataset,
              requirement,
              payload
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            "#,
            params![
                record.id.to_string(),
                record.metadata.timestamp.to_rfc3339(),
                &record.metadata.domain,
                &record.metadata.complexity,
                if record.metadata.consented_to_dataset {
                    1
                } else {
                    0
                },
                &record.requirement,
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
            SELECT id, created_at, domain, complexity, consented_to_dataset, requirement
            FROM sessions
            ORDER BY created_at DESC
            LIMIT ?1
            "#,
        )
        .map_err(|err| format!("failed to prepare list query: {err}"))?;

    let rows = statement
        .query_map(params![limit as i64], |row| {
            let requirement: String = row.get(5)?;
            let preview = requirement.chars().take(120).collect::<String>();

            Ok(SessionSummary {
                id: row.get(0)?,
                created_at: row.get(1)?,
                domain: row.get(2)?,
                complexity: row.get(3)?,
                consented_to_dataset: row.get::<_, i64>(4)? == 1,
                requirement_preview: preview,
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
              domain TEXT NOT NULL,
              complexity TEXT NOT NULL,
              consented_to_dataset INTEGER NOT NULL,
              requirement TEXT NOT NULL,
              payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at DESC);
            "#,
        )
        .map_err(|err| format!("failed to initialize sqlite schema: {err}"))
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
