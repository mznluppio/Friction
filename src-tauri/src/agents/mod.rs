use crate::session::{
    AgentPlan, AgentResponse, AttackReportItem, NamedAgentPlan, NamedAgentResponse, PlanPhase,
};
use chrono::{DateTime, Utc};
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, UNIX_EPOCH};
use tokio::io::AsyncReadExt;
use tokio::process::Command as TokioCommand;
use uuid::Uuid;

const SYSTEM_ARCHITECT: &str = r#"Tu es \"L'Architecte\" — un ingénieur senior obsédé par la clarté des specs, la maintenabilité long-terme, et les edge cases. Tu es prudent, tu questionnes les hypothèses implicites, tu identifies ce qui manque dans un requirement avant de coder.

Quand tu reçois un requirement, réponds UNIQUEMENT en JSON valide avec cette structure exacte:
{
  \"interpretation\": \"Comment tu comprends le requirement en 2-3 phrases\",
  \"assumptions\": [\"hypothèse implicite 1\", \"hypothèse implicite 2\", \"hypothèse implicite 3\"],
  \"risks\": [\"risque ou edge case 1\", \"risque ou edge case 2\"],
  \"questions\": [\"question critique 1\", \"question critique 2\"],
  \"approach\": \"Ton approche technique en 2-3 phrases\"
}"#;

const SYSTEM_PRAGMATIST: &str = r#"Tu es \"Le Pragmatiste\" — un dev qui ship vite, qui pense MVP, qui évite la sur-ingénierie. Tu prends les requirements au pied de la lettre, tu trouves la solution la plus simple qui fonctionne, tu ne te perds pas dans des cas hypothétiques.

Quand tu reçois un requirement, réponds UNIQUEMENT en JSON valide avec cette structure exacte:
{
  \"interpretation\": \"Comment tu comprends le requirement en 2-3 phrases\",
  \"assumptions\": [\"hypothèse implicite 1\", \"hypothèse implicite 2\", \"hypothèse implicite 3\"],
  \"risks\": [\"risque ou edge case 1\", \"risque ou edge case 2\"],
  \"questions\": [\"question critique 1\", \"question critique 2\"],
  \"approach\": \"Ton approche technique en 2-3 phrases\"
}"#;

const SYSTEM_ARCHITECT_PLAN: &str = r#"Tu es \"L'Architecte\" — ingénieur senior, rigoureux, orienté maintenabilité et robustesse.

Tu reçois un problem statement original + des clarifications du client. Produis un brief d'approche détaillé, utile pour réfléchir à un bug, une décision, une hypothèse ou une investigation.
Réponds UNIQUEMENT en JSON valide:
{
  \"problem_read\": \"Comment tu cadres le problème en 2-4 phrases\",
  \"main_hypothesis\": \"Hypothèse ou angle principal retenu\",
  \"strategy\": \"Stratégie d'investigation ou de résolution en 3-4 phrases\",
  \"tradeoffs\": [\"tradeoff ou décision clé 1\", \"tradeoff ou décision clé 2\"],
  \"next_steps\": [\"prochaine étape 1\", \"prochaine étape 2\", \"prochaine étape 3\"],
  \"risks\": [\"risque ouvert 1\", \"risque ouvert 2\"],
  \"open_questions\": [\"question ouverte 1\", \"question ouverte 2\"]
}"#;

const SYSTEM_PRAGMATIST_PLAN: &str = r#"Tu es \"Le Pragmatiste\" — dev orienté livraison rapide, MVP, simplicité.

Tu reçois un problem statement original + des clarifications du client. Produis un brief d'approche concis et actionnable.
Réponds UNIQUEMENT en JSON valide:
{
  \"problem_read\": \"Comment tu cadres le problème en 2-4 phrases\",
  \"main_hypothesis\": \"Hypothèse ou angle principal retenu\",
  \"strategy\": \"Stratégie d'investigation ou de résolution en 3-4 phrases\",
  \"tradeoffs\": [\"tradeoff ou décision clé 1\", \"tradeoff ou décision clé 2\"],
  \"next_steps\": [\"prochaine étape 1\", \"prochaine étape 2\", \"prochaine étape 3\"],
  \"risks\": [\"risque ouvert 1\", \"risque ouvert 2\"],
  \"open_questions\": [\"question ouverte 1\", \"question ouverte 2\"]
}"#;

const SYSTEM_ADDITIONAL_ANALYST: &str = r#"Tu es un agent d'analyse indépendant. Tu dois apporter un angle distinct (risques cachés, coûts, exploitation ou robustesse), sans répéter les autres.

Quand tu reçois un requirement, réponds UNIQUEMENT en JSON valide avec cette structure exacte:
{
  \"interpretation\": \"Comment tu comprends le requirement en 2-3 phrases\",
  \"assumptions\": [\"hypothèse implicite 1\", \"hypothèse implicite 2\", \"hypothèse implicite 3\"],
  \"risks\": [\"risque ou edge case 1\", \"risque ou edge case 2\"],
  \"questions\": [\"question critique 1\", \"question critique 2\"],
  \"approach\": \"Ton approche technique en 2-3 phrases\"
}"#;

const SYSTEM_ADDITIONAL_PLANNER: &str = r#"Tu es un agent de planification indépendant. Tu dois proposer un brief d'approche distinct et concret avec un angle complémentaire (performance, sécurité, opérations, coût).

Tu reçois un problem statement original + des clarifications du client. Produis un brief d'approche détaillé.
Réponds UNIQUEMENT en JSON valide:
{
  \"problem_read\": \"Comment tu cadres le problème en 2-4 phrases\",
  \"main_hypothesis\": \"Hypothèse ou angle principal retenu\",
  \"strategy\": \"Stratégie d'investigation ou de résolution en 3-4 phrases\",
  \"tradeoffs\": [\"tradeoff ou décision clé 1\", \"tradeoff ou décision clé 2\"],
  \"next_steps\": [\"prochaine étape 1\", \"prochaine étape 2\", \"prochaine étape 3\"],
  \"risks\": [\"risque ouvert 1\", \"risque ouvert 2\"],
  \"open_questions\": [\"question ouverte 1\", \"question ouverte 2\"]
}"#;

const AGENT_A_CLI_PROMPT: &str = r#"You are Agent A in an adversarial validation workflow.
Produce one TypeScript file content only (no Markdown fences, no explanations).
The file must compile and include explicit input validation and failure paths.
"#;

const AGENT_B_ATTACK_PROMPT: &str = r#"You are Agent B in an adversarial validation workflow.
You receive only the requirement and Agent A final code. You must attack the code.
Return STRICT JSON only with this schema:
{
  "attack_report": [
    { "severity": "high|medium|low", "title": "...", "detail": "..." }
  ]
}
"#;

const CLI_MODELS_CACHE_FRESH_SECS: i64 = 600;
const CLI_MODELS_CACHE_HARD_SECS: i64 = 86_400;
const CLI_MODELS_HTTP_TIMEOUT_SECS: u64 = 8;
const CLI_MODELS_HTTP_CONNECT_TIMEOUT_SECS: u64 = 2;
const CLI_MODELS_OUTPUT_MAX_BYTES: usize = 1_000_000;
const GEMINI_LOCAL_USAGE_SCAN_MAX_FILES: usize = 24;
const CLI_TIMELINE_FALLBACK_OUTPUT_MAX_CHARS: usize = 32 * 1024;
const CLI_TIMELINE_HEARTBEAT_SECS: u64 = 1;

static CLI_MODELS_CACHE: OnceLock<Mutex<HashMap<String, CliModelsCacheEntry>>> = OnceLock::new();
static CLI_MODELS_REFRESH_INFLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

#[derive(Debug)]
struct CliExecutionResult {
    stdout: String,
    stderr: String,
    command_id: Option<String>,
    streamed_chunk_count: usize,
    timed_out: bool,
}

pub const CLI_COMMAND_LOG_EVENT_NAME: &str = "friction://cli-command-log";
pub const PHASE12_CLI_LOG_EVENT_NAME: &str = "friction://phase12-cli-log";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CliCommandLogKind {
    RunStarted,
    CommandStarted,
    CommandChunk,
    CommandFinished,
    RunFinished,
    RunFailed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliCommandLogEvent {
    pub request_id: String,
    pub phase: u8,
    pub kind: CliCommandLogKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_cli: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub timestamp: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Phase12CliLogKind {
    RunStarted,
    AgentStarted,
    AgentChunk,
    AgentFinished,
    RunFinished,
    RunFailed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Phase12CliLogEvent {
    pub request_id: String,
    pub phase: u8,
    pub kind: Phase12CliLogKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_cli: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub timestamp: String,
}

pub type CliCommandLogEmitter = Arc<dyn Fn(CliCommandLogEvent) + Send + Sync>;
pub type Phase12CliLogEmitter = Arc<dyn Fn(Phase12CliLogEvent) + Send + Sync>;

#[derive(Clone)]
pub struct Phase12CliRunContext {
    pub request_id: String,
    pub phase: u8,
    pub emitter: CliCommandLogEmitter,
    pub legacy_phase12_emitter: Option<Phase12CliLogEmitter>,
}

#[derive(Clone)]
pub struct Phase12CliAgentContext {
    pub request_id: String,
    pub phase: u8,
    pub agent_id: String,
    pub agent_label: String,
    pub agent_cli: String,
    pub emitter: CliCommandLogEmitter,
    pub legacy_phase12_emitter: Option<Phase12CliLogEmitter>,
}

#[derive(Clone, Copy)]
enum CliOutputStreamKind {
    Stdout,
    Stderr,
}

#[derive(Debug, Deserialize)]
struct AttackReportEnvelope {
    attack_report: Vec<AttackReportItem>,
}

#[derive(Debug, Clone, Copy)]
enum AgentRole {
    Architect,
    Pragmatist,
}

#[derive(Debug, Clone)]
enum ProviderKind {
    Mock,
    Anthropic { api_key: String },
    OpenAi { api_key: String },
    Ollama { host: String },
}

#[derive(Debug, Clone)]
struct RuntimeAgent {
    pub model: String,
    pub role: AgentRole,
    pub provider: ProviderKind,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeAgentInput {
    pub provider: String,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfigInput {
    #[serde(default)]
    pub architect: Option<RuntimeAgentInput>,
    #[serde(default)]
    pub pragmatist: Option<RuntimeAgentInput>,
    #[serde(default, alias = "ollama_host")]
    pub ollama_host: Option<String>,
    #[serde(default, alias = "cli_commands")]
    pub cli_commands: Option<HashMap<String, String>>,
    #[serde(default, alias = "cli_models")]
    pub cli_models: Option<HashMap<String, String>>,
    #[serde(default, alias = "agent_cli_models")]
    pub agent_cli_models: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseAgentInput {
    pub id: String,
    pub label: String,
    pub cli: String,
}

#[derive(Debug, Clone)]
pub struct ResolvedPhaseAgent {
    pub id: String,
    pub label: String,
    pub cli: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Phase12CliDiagnosticsOutput {
    pub agents: Vec<PhaseAgentCliDiagnostic>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliModelsListOutput {
    pub models: Vec<String>,
    pub source: String,
    pub reason: Option<String>,
    pub stale: bool,
    pub last_updated_at: Option<String>,
    pub provider_mode: Option<String>,
}

#[derive(Debug, Clone)]
struct CliModelsFetchResult {
    models: Vec<String>,
    source: String,
    reason: Option<String>,
    provider_mode: Option<String>,
}

#[derive(Debug, Clone)]
struct CliModelsLiveResult {
    models: Vec<String>,
    mode: String,
}

#[derive(Debug, Clone)]
struct CliModelsCacheEntry {
    models: Vec<String>,
    source: String,
    reason: Option<String>,
    provider_mode: Option<String>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseAgentCliDiagnostic {
    pub id: String,
    pub label: String,
    pub selected_cli: String,
    pub resolved_command: String,
    pub resolved_command_source: String,
    pub resolved_binary_path: Option<String>,
    pub resolved_family: String,
    pub resolved_model: Option<String>,
    pub resolved_model_source: Option<String>,
    pub runtime_ready: bool,
    pub readiness_reason: Option<String>,
    pub readiness_source: String,
    pub requires_auth: bool,
}

#[derive(Debug, Clone)]
struct CliCommandResolution {
    command: String,
    source: String,
}

#[derive(Debug, Clone)]
struct AgentCliModelResolution {
    model: Option<String>,
    source: Option<String>,
}

#[derive(Debug, Clone)]
struct CodexProviderConfigEntry {
    name: String,
    base_url: String,
    env_key: Option<String>,
}

#[derive(Debug, Clone)]
struct CodexRuntimeReadiness {
    runtime_ready: bool,
    readiness_reason: Option<String>,
    readiness_source: String,
    host_auth_path: Option<PathBuf>,
}

#[derive(Debug, Clone)]
struct GeminiRuntimeReadiness {
    runtime_ready: bool,
    readiness_reason: Option<String>,
    readiness_source: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliExecutionIsolationMode {
    StrictPhase12,
    SharedWorktree,
}

#[derive(Debug)]
enum CliChildEnvironment {
    Inherit,
    Strict {
        preserved: Vec<(String, String)>,
        overrides: Vec<(String, String)>,
    },
}

#[derive(Debug)]
struct CliExecutionContext {
    workdir: PathBuf,
    capture_base_dir: Option<PathBuf>,
    child_environment: CliChildEnvironment,
    _cleanup_guard: Option<StrictIsolationCleanup>,
}

#[derive(Debug)]
struct StrictIsolationCleanup {
    root: PathBuf,
}

impl Drop for StrictIsolationCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn cli_log_timestamp() -> String {
    Utc::now().to_rfc3339()
}

fn map_stream_kind(stream: CliOutputStreamKind) -> String {
    match stream {
        CliOutputStreamKind::Stdout => "stdout".to_string(),
        CliOutputStreamKind::Stderr => "stderr".to_string(),
    }
}

fn map_command_kind_to_phase12(kind: CliCommandLogKind) -> Phase12CliLogKind {
    match kind {
        CliCommandLogKind::RunStarted => Phase12CliLogKind::RunStarted,
        CliCommandLogKind::CommandStarted => Phase12CliLogKind::AgentStarted,
        CliCommandLogKind::CommandChunk => Phase12CliLogKind::AgentChunk,
        CliCommandLogKind::CommandFinished => Phase12CliLogKind::AgentFinished,
        CliCommandLogKind::RunFinished => Phase12CliLogKind::RunFinished,
        CliCommandLogKind::RunFailed => Phase12CliLogKind::RunFailed,
    }
}

fn emit_legacy_phase12_cli_log(context: &Phase12CliRunContext, mut event: Phase12CliLogEvent) {
    let Some(legacy_emitter) = context.legacy_phase12_emitter.as_ref() else {
        return;
    };
    if context.phase > 2 {
        return;
    }
    event.request_id = context.request_id.clone();
    event.phase = context.phase;
    if event.timestamp.trim().is_empty() {
        event.timestamp = cli_log_timestamp();
    }
    (legacy_emitter)(event);
}

fn emit_cli_command_log(context: &Phase12CliRunContext, mut event: CliCommandLogEvent) {
    event.request_id = context.request_id.clone();
    event.phase = context.phase;
    if event.timestamp.trim().is_empty() {
        event.timestamp = cli_log_timestamp();
    }
    (context.emitter)(event);
}

fn emit_cli_command_event(
    context: &Phase12CliAgentContext,
    kind: CliCommandLogKind,
    command_id: Option<String>,
    stream: Option<CliOutputStreamKind>,
    chunk: Option<String>,
    command: Option<String>,
    command_source: Option<String>,
    resolved_path: Option<String>,
    model: Option<String>,
    model_source: Option<String>,
    exit_code: Option<i32>,
) {
    let timestamp = cli_log_timestamp();
    let stream_label = stream.map(map_stream_kind);
    (context.emitter)(CliCommandLogEvent {
        request_id: context.request_id.clone(),
        phase: context.phase,
        kind,
        command_id,
        agent_id: Some(context.agent_id.clone()),
        agent_label: Some(context.agent_label.clone()),
        agent_cli: Some(context.agent_cli.clone()),
        stream: stream_label.clone(),
        chunk: chunk.clone(),
        command: command.clone(),
        command_source: command_source.clone(),
        resolved_path: resolved_path.clone(),
        model: model.clone(),
        model_source: model_source.clone(),
        exit_code,
        timestamp: timestamp.clone(),
    });

    if context.phase <= 2 {
        if let Some(legacy_emitter) = context.legacy_phase12_emitter.as_ref() {
            (legacy_emitter)(Phase12CliLogEvent {
                request_id: context.request_id.clone(),
                phase: context.phase,
                kind: map_command_kind_to_phase12(kind),
                agent_id: Some(context.agent_id.clone()),
                agent_label: Some(context.agent_label.clone()),
                agent_cli: Some(context.agent_cli.clone()),
                stream: stream_label,
                chunk,
                command,
                command_source,
                resolved_path,
                model,
                model_source,
                exit_code,
                timestamp,
            });
        }
    }
}

pub fn emit_phase12_run_started(context: &Phase12CliRunContext) {
    let timestamp = cli_log_timestamp();
    emit_cli_command_log(
        context,
        CliCommandLogEvent {
            request_id: String::new(),
            phase: 0,
            kind: CliCommandLogKind::RunStarted,
            command_id: None,
            agent_id: None,
            agent_label: None,
            agent_cli: None,
            stream: None,
            chunk: None,
            command: None,
            command_source: None,
            resolved_path: None,
            model: None,
            model_source: None,
            exit_code: None,
            timestamp: timestamp.clone(),
        },
    );
    emit_legacy_phase12_cli_log(
        context,
        Phase12CliLogEvent {
            request_id: String::new(),
            phase: 0,
            kind: Phase12CliLogKind::RunStarted,
            agent_id: None,
            agent_label: None,
            agent_cli: None,
            stream: None,
            chunk: None,
            command: None,
            command_source: None,
            resolved_path: None,
            model: None,
            model_source: None,
            exit_code: None,
            timestamp,
        },
    );
}

pub fn emit_phase12_run_finished(context: &Phase12CliRunContext) {
    let timestamp = cli_log_timestamp();
    emit_cli_command_log(
        context,
        CliCommandLogEvent {
            request_id: String::new(),
            phase: 0,
            kind: CliCommandLogKind::RunFinished,
            command_id: None,
            agent_id: None,
            agent_label: None,
            agent_cli: None,
            stream: None,
            chunk: None,
            command: None,
            command_source: None,
            resolved_path: None,
            model: None,
            model_source: None,
            exit_code: None,
            timestamp: timestamp.clone(),
        },
    );
    emit_legacy_phase12_cli_log(
        context,
        Phase12CliLogEvent {
            request_id: String::new(),
            phase: 0,
            kind: Phase12CliLogKind::RunFinished,
            agent_id: None,
            agent_label: None,
            agent_cli: None,
            stream: None,
            chunk: None,
            command: None,
            command_source: None,
            resolved_path: None,
            model: None,
            model_source: None,
            exit_code: None,
            timestamp,
        },
    );
}

pub fn emit_phase12_run_failed(context: &Phase12CliRunContext, reason: String) {
    let timestamp = cli_log_timestamp();
    emit_cli_command_log(
        context,
        CliCommandLogEvent {
            request_id: String::new(),
            phase: 0,
            kind: CliCommandLogKind::RunFailed,
            command_id: None,
            agent_id: None,
            agent_label: None,
            agent_cli: None,
            stream: None,
            chunk: Some(reason.clone()),
            command: None,
            command_source: None,
            resolved_path: None,
            model: None,
            model_source: None,
            exit_code: None,
            timestamp: timestamp.clone(),
        },
    );
    emit_legacy_phase12_cli_log(
        context,
        Phase12CliLogEvent {
            request_id: String::new(),
            phase: 0,
            kind: Phase12CliLogKind::RunFailed,
            agent_id: None,
            agent_label: None,
            agent_cli: None,
            stream: None,
            chunk: Some(reason),
            command: None,
            command_source: None,
            resolved_path: None,
            model: None,
            model_source: None,
            exit_code: None,
            timestamp,
        },
    );
}

impl AgentRole {
    fn analysis_prompt(self) -> &'static str {
        match self {
            AgentRole::Architect => SYSTEM_ARCHITECT,
            AgentRole::Pragmatist => SYSTEM_PRAGMATIST,
        }
    }

    fn plan_prompt(self) -> &'static str {
        match self {
            AgentRole::Architect => SYSTEM_ARCHITECT_PLAN,
            AgentRole::Pragmatist => SYSTEM_PRAGMATIST_PLAN,
        }
    }
}

fn has_non_empty_items(items: &[String]) -> bool {
    items.iter().any(|item| !item.trim().is_empty())
}

fn validate_agent_response_content(response: &AgentResponse) -> Result<(), String> {
    let has_content = !response.interpretation.trim().is_empty()
        || !response.approach.trim().is_empty()
        || has_non_empty_items(&response.assumptions)
        || has_non_empty_items(&response.risks)
        || has_non_empty_items(&response.questions);

    if has_content {
        Ok(())
    } else {
        Err(
            "JSON valid but empty response payload. Ensure CLI returns at least one non-empty field."
                .to_string(),
        )
    }
}

fn phase_contains_non_empty_content(phase: &PlanPhase) -> bool {
    !phase.name.trim().is_empty()
        || !phase.duration.trim().is_empty()
        || has_non_empty_items(&phase.tasks)
}

fn normalize_agent_plan(mut plan: AgentPlan) -> AgentPlan {
    if plan.next_steps.is_empty() {
        plan.next_steps = plan
            .phases
            .iter()
            .flat_map(|phase| phase.tasks.clone())
            .filter(|task| !task.trim().is_empty())
            .collect();
    }

    if plan.risks.is_empty() {
        plan.risks = plan.warnings.clone();
    }

    if plan.strategy.trim().is_empty() {
        plan.strategy = if !plan.architecture.trim().is_empty() {
            plan.architecture.clone()
        } else if !plan.problem_read.trim().is_empty() {
            plan.problem_read.clone()
        } else {
            "No explicit strategy captured.".to_string()
        };
    }

    if plan.problem_read.trim().is_empty() {
        plan.problem_read = if !plan.architecture.trim().is_empty() {
            format!(
                "Frames the problem through this approach: {}",
                plan.architecture
            )
        } else if !plan.strategy.trim().is_empty() {
            plan.strategy.clone()
        } else {
            "No explicit problem framing captured.".to_string()
        };
    }

    if plan.main_hypothesis.trim().is_empty() {
        plan.main_hypothesis = plan
            .tradeoffs
            .iter()
            .find(|item| !item.trim().is_empty())
            .cloned()
            .or_else(|| {
                plan.risks
                    .iter()
                    .find(|item| !item.trim().is_empty())
                    .cloned()
            })
            .unwrap_or_else(|| plan.strategy.clone());
    }

    if plan.architecture.trim().is_empty() {
        plan.architecture = plan.strategy.clone();
    }

    if plan.warnings.is_empty() {
        plan.warnings = plan.risks.clone();
    }

    plan
}

fn validate_agent_plan_content(plan: &AgentPlan) -> Result<(), String> {
    let has_content = !plan.problem_read.trim().is_empty()
        || !plan.main_hypothesis.trim().is_empty()
        || !plan.strategy.trim().is_empty()
        || !plan.architecture.trim().is_empty()
        || has_non_empty_items(&plan.stack)
        || plan.phases.iter().any(phase_contains_non_empty_content)
        || has_non_empty_items(&plan.tradeoffs)
        || has_non_empty_items(&plan.warnings)
        || has_non_empty_items(&plan.next_steps)
        || has_non_empty_items(&plan.risks)
        || has_non_empty_items(&plan.open_questions);

    if has_content {
        Ok(())
    } else {
        Err(
            "JSON valid but empty plan payload. Ensure CLI returns at least one non-empty field."
                .to_string(),
        )
    }
}

impl RuntimeAgent {
    async fn analyze_requirement(&self, requirement: &str) -> Result<AgentResponse, String> {
        match &self.provider {
            ProviderKind::Mock => Ok(mock_response(self.role, requirement)),
            _ => {
                let raw = self
                    .call_provider(self.role.analysis_prompt(), requirement)
                    .await?;
                let response = parse_json_payload::<AgentResponse>(&raw)?;
                validate_agent_response_content(&response)
                    .map_err(|err| format!("Provider response invalid: {err}"))?;
                Ok(response)
            }
        }
    }

    async fn build_plan(
        &self,
        requirement: &str,
        clarifications: &str,
    ) -> Result<AgentPlan, String> {
        match &self.provider {
            ProviderKind::Mock => Ok(mock_plan(self.role, requirement, clarifications)),
            _ => {
                let user_payload = format!(
                    "Requirement original: {requirement}\n\nClarifications du client:\n{clarifications}"
                );
                let raw = self
                    .call_provider(self.role.plan_prompt(), &user_payload)
                    .await?;
                let plan = normalize_agent_plan(parse_json_payload::<AgentPlan>(&raw)?);
                validate_agent_plan_content(&plan)
                    .map_err(|err| format!("Provider response invalid: {err}"))?;
                Ok(plan)
            }
        }
    }

    async fn call_provider(
        &self,
        system_prompt: &str,
        user_prompt: &str,
    ) -> Result<String, String> {
        let client = reqwest::Client::new();

        match &self.provider {
            ProviderKind::Anthropic { api_key } => {
                let response = client
                    .post("https://api.anthropic.com/v1/messages")
                    .header("x-api-key", api_key)
                    .header("anthropic-version", "2023-06-01")
                    .header(CONTENT_TYPE, "application/json")
                    .json(&serde_json::json!({
                        "model": self.model,
                        "max_tokens": 1600,
                        "temperature": 0.2,
                        "system": system_prompt,
                        "messages": [
                            { "role": "user", "content": user_prompt }
                        ]
                    }))
                    .send()
                    .await
                    .map_err(|err| format!("Anthropic request failed: {err}"))?;

                let status = response.status();
                let payload: Value = response
                    .json()
                    .await
                    .map_err(|err| format!("Anthropic JSON decode failed: {err}"))?;

                if !status.is_success() {
                    return Err(format!("Anthropic error ({status}): {payload}"));
                }

                let text = payload
                    .get("content")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|item| item.get("text").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default();

                if text.trim().is_empty() {
                    return Err("Anthropic returned empty text content".to_string());
                }

                Ok(text)
            }
            ProviderKind::OpenAi { api_key } => {
                let response = client
                    .post("https://api.openai.com/v1/chat/completions")
                    .header(AUTHORIZATION, format!("Bearer {api_key}"))
                    .header(CONTENT_TYPE, "application/json")
                    .json(&serde_json::json!({
                        "model": self.model,
                        "temperature": 0.2,
                        "messages": [
                            { "role": "system", "content": system_prompt },
                            { "role": "user", "content": user_prompt }
                        ]
                    }))
                    .send()
                    .await
                    .map_err(|err| format!("OpenAI request failed: {err}"))?;

                let status = response.status();
                let payload: Value = response
                    .json()
                    .await
                    .map_err(|err| format!("OpenAI JSON decode failed: {err}"))?;

                if !status.is_success() {
                    return Err(format!("OpenAI error ({status}): {payload}"));
                }

                let text = payload
                    .get("choices")
                    .and_then(Value::as_array)
                    .and_then(|choices| choices.first())
                    .and_then(|choice| choice.get("message"))
                    .and_then(|message| message.get("content"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();

                if text.trim().is_empty() {
                    return Err("OpenAI returned empty message content".to_string());
                }

                Ok(text)
            }
            ProviderKind::Ollama { host } => {
                let endpoint = format!("{}/api/chat", host.trim_end_matches('/'));
                let response = client
                    .post(endpoint)
                    .header(CONTENT_TYPE, "application/json")
                    .json(&serde_json::json!({
                        "model": self.model,
                        "stream": false,
                        "messages": [
                            { "role": "system", "content": system_prompt },
                            { "role": "user", "content": user_prompt }
                        ]
                    }))
                    .send()
                    .await
                    .map_err(|err| format!("Ollama request failed: {err}"))?;

                let status = response.status();
                let payload: Value = response
                    .json()
                    .await
                    .map_err(|err| format!("Ollama JSON decode failed: {err}"))?;

                if !status.is_success() {
                    return Err(format!("Ollama error ({status}): {payload}"));
                }

                let text = payload
                    .get("message")
                    .and_then(|message| message.get("content"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();

                if text.trim().is_empty() {
                    return Err("Ollama returned empty message content".to_string());
                }

                Ok(text)
            }
            ProviderKind::Mock => Err("Mock provider does not call remote APIs".to_string()),
        }
    }
}

pub async fn analyze_dual(
    requirement: &str,
    runtime_config: Option<&RuntimeConfigInput>,
) -> Result<(AgentResponse, AgentResponse), String> {
    let (architect, pragmatist) = runtime_agents(runtime_config)?;

    let (arch_result, prag_result) = tokio::join!(
        architect.analyze_requirement(requirement),
        pragmatist.analyze_requirement(requirement)
    );

    Ok((arch_result?, prag_result?))
}

pub async fn plan_dual(
    requirement: &str,
    clarifications: &str,
    runtime_config: Option<&RuntimeConfigInput>,
) -> Result<(AgentPlan, AgentPlan), String> {
    let (architect, pragmatist) = runtime_agents(runtime_config)?;

    let (arch_result, prag_result) = tokio::join!(
        architect.build_plan(requirement, clarifications),
        pragmatist.build_plan(requirement, clarifications)
    );

    Ok((arch_result?, prag_result?))
}

pub fn legacy_provider_mode_enabled() -> bool {
    env::var("FRICTION_ENABLE_LEGACY_PROVIDER_MODE")
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

pub fn resolve_phase_agents(
    phase_agents: Option<&[PhaseAgentInput]>,
    agent_a_cli: Option<&str>,
    agent_b_cli: Option<&str>,
) -> Result<Vec<ResolvedPhaseAgent>, String> {
    if let Some(items) = phase_agents {
        if items.len() < 2 {
            return Err("phase_agents must include at least 2 agents".to_string());
        }
        if items.len() > 4 {
            return Err("phase_agents currently supports up to 4 agents".to_string());
        }

        let mut seen_ids = std::collections::HashSet::new();
        let mut resolved = Vec::with_capacity(items.len());
        for (index, agent) in items.iter().enumerate() {
            let id = agent.id.trim().to_string();
            if id.is_empty() {
                return Err(format!("phase_agents[{index}] has an empty id"));
            }
            if !seen_ids.insert(id.clone()) {
                return Err(format!("phase_agents contains duplicate id '{id}'"));
            }

            let label = if agent.label.trim().is_empty() {
                format!("Agent {}", index + 1)
            } else {
                agent.label.trim().to_string()
            };
            let cli =
                resolve_agent_cli(Some(agent.cli.as_str()), "claude", &format!("{label} CLI"))?;

            resolved.push(ResolvedPhaseAgent { id, label, cli });
        }

        return Ok(resolved);
    }

    Ok(vec![
        ResolvedPhaseAgent {
            id: "agent_a".to_string(),
            label: "Agent A".to_string(),
            cli: resolve_agent_a_cli(agent_a_cli)?,
        },
        ResolvedPhaseAgent {
            id: "agent_b".to_string(),
            label: "Agent B".to_string(),
            cli: resolve_reviewer_cli(agent_b_cli)?,
        },
    ])
}

fn analysis_prompt_for_agent(
    agent: &ResolvedPhaseAgent,
    index: usize,
    requirement: &str,
) -> String {
    let system = match index {
        0 => SYSTEM_ARCHITECT,
        1 => SYSTEM_PRAGMATIST,
        _ => SYSTEM_ADDITIONAL_ANALYST,
    };
    format!(
        "{system}\n\nAgent label: {}\nRequirement original:\n{requirement}\n\nRéponds avec exactement un objet JSON valide qui respecte le schéma demandé. N'appelle aucun outil (tool/function/question/webfetch). Aucun markdown, aucun texte hors JSON.",
        agent.label
    )
}

fn plan_prompt_for_agent(
    agent: &ResolvedPhaseAgent,
    index: usize,
    requirement: &str,
    clarifications: &str,
) -> String {
    let system = match index {
        0 => SYSTEM_ARCHITECT_PLAN,
        1 => SYSTEM_PRAGMATIST_PLAN,
        _ => SYSTEM_ADDITIONAL_PLANNER,
    };
    format!(
        "{system}\n\nAgent label: {}\nRequirement original: {requirement}\n\nClarifications du client:\n{clarifications}\n\nRéponds avec exactement un objet JSON valide qui respecte le schéma demandé. N'appelle aucun outil (tool/function/question/webfetch). Aucun markdown, aucun texte hors JSON.",
        agent.label
    )
}

pub async fn analyze_multi_via_cli(
    requirement: &str,
    phase_agents: &[ResolvedPhaseAgent],
    runtime_config: Option<&RuntimeConfigInput>,
    phase12_run_context: Option<&Phase12CliRunContext>,
) -> Result<Vec<NamedAgentResponse>, String> {
    let mut outputs = Vec::with_capacity(phase_agents.len());

    for (index, agent) in phase_agents.iter().enumerate() {
        let phase12_agent_context = phase12_run_context.map(|context| Phase12CliAgentContext {
            request_id: context.request_id.clone(),
            phase: context.phase,
            agent_id: agent.id.clone(),
            agent_label: agent.label.clone(),
            agent_cli: agent.cli.clone(),
            emitter: Arc::clone(&context.emitter),
            legacy_phase12_emitter: context.legacy_phase12_emitter.clone(),
        });
        let prompt = analysis_prompt_for_agent(agent, index, requirement);
        let label = format!("{} CLI phase1 analysis", agent.label);
        let parse_and_validate = |raw: &str| -> Result<AgentResponse, String> {
            let response = parse_json_payload::<AgentResponse>(raw)?;
            validate_agent_response_content(&response)?;
            Ok(response)
        };

        let raw = run_agent_cli(
            &agent.cli,
            Some(agent.id.as_str()),
            &prompt,
            ".",
            None,
            &label,
            runtime_config,
            CliExecutionIsolationMode::StrictPhase12,
            phase12_agent_context.as_ref(),
        )
        .await?;
        let response = match parse_and_validate(&raw) {
            Ok(response) => response,
            Err(err) if agent.cli == "opencode" && should_retry_opencode_json_parse(&err) => {
                let retry_prompt = strict_json_retry_prompt(&prompt);
                let retry_label = format!("{label} (strict-json retry)");
                let retry_raw = run_agent_cli(
                    &agent.cli,
                    Some(agent.id.as_str()),
                    &retry_prompt,
                    ".",
                    None,
                    &retry_label,
                    runtime_config,
                    CliExecutionIsolationMode::StrictPhase12,
                    phase12_agent_context.as_ref(),
                )
                .await?;
                match parse_and_validate(&retry_raw) {
                    Ok(response) => response,
                    Err(retry_err) => {
                        if let Some(coerced) = coerce_agent_response_from_raw(&raw)
                            .or_else(|| coerce_agent_response_from_raw(&retry_raw))
                        {
                            coerced
                        } else {
                            return Err(format!(
                                "{label} JSON invalid after strict retry: initial={}; retry={}",
                                compact_cli_parse_error(&err),
                                compact_cli_parse_error(&retry_err)
                            ));
                        }
                    }
                }
            }
            Err(err) if agent.cli == "opencode" => {
                if let Some(coerced) = coerce_agent_response_from_raw(&raw) {
                    coerced
                } else {
                    return Err(format!(
                        "{label} JSON invalid: {}",
                        compact_cli_parse_error(&err)
                    ));
                }
            }
            Err(err) => {
                return Err(format!(
                    "{label} JSON invalid: {}",
                    compact_cli_parse_error(&err)
                ))
            }
        };
        outputs.push(NamedAgentResponse {
            id: agent.id.clone(),
            label: agent.label.clone(),
            cli: agent.cli.clone(),
            response,
        });
    }

    Ok(outputs)
}

pub async fn plan_multi_via_cli(
    requirement: &str,
    clarifications: &str,
    phase_agents: &[ResolvedPhaseAgent],
    runtime_config: Option<&RuntimeConfigInput>,
    phase12_run_context: Option<&Phase12CliRunContext>,
) -> Result<Vec<NamedAgentPlan>, String> {
    let mut outputs = Vec::with_capacity(phase_agents.len());

    for (index, agent) in phase_agents.iter().enumerate() {
        let phase12_agent_context = phase12_run_context.map(|context| Phase12CliAgentContext {
            request_id: context.request_id.clone(),
            phase: context.phase,
            agent_id: agent.id.clone(),
            agent_label: agent.label.clone(),
            agent_cli: agent.cli.clone(),
            emitter: Arc::clone(&context.emitter),
            legacy_phase12_emitter: context.legacy_phase12_emitter.clone(),
        });
        let prompt = plan_prompt_for_agent(agent, index, requirement, clarifications);
        let label = format!("{} CLI phase2 planning", agent.label);
        let parse_and_validate = |raw: &str| -> Result<AgentPlan, String> {
            let plan = normalize_agent_plan(parse_json_payload::<AgentPlan>(raw)?);
            validate_agent_plan_content(&plan)?;
            Ok(plan)
        };
        let raw = run_agent_cli(
            &agent.cli,
            Some(agent.id.as_str()),
            &prompt,
            ".",
            None,
            &label,
            runtime_config,
            CliExecutionIsolationMode::StrictPhase12,
            phase12_agent_context.as_ref(),
        )
        .await?;
        let plan = match parse_and_validate(&raw) {
            Ok(plan) => plan,
            Err(err) if agent.cli == "opencode" && should_retry_opencode_json_parse(&err) => {
                let retry_prompt = strict_json_retry_prompt(&prompt);
                let retry_label = format!("{label} (strict-json retry)");
                let retry_raw = run_agent_cli(
                    &agent.cli,
                    Some(agent.id.as_str()),
                    &retry_prompt,
                    ".",
                    None,
                    &retry_label,
                    runtime_config,
                    CliExecutionIsolationMode::StrictPhase12,
                    phase12_agent_context.as_ref(),
                )
                .await?;
                match parse_and_validate(&retry_raw) {
                    Ok(plan) => plan,
                    Err(retry_err) => {
                        if let Some(coerced) = coerce_agent_plan_from_raw(&raw)
                            .or_else(|| coerce_agent_plan_from_raw(&retry_raw))
                        {
                            coerced
                        } else {
                            return Err(format!(
                                "{label} JSON invalid after strict retry: initial={}; retry={}",
                                compact_cli_parse_error(&err),
                                compact_cli_parse_error(&retry_err)
                            ));
                        }
                    }
                }
            }
            Err(err) if agent.cli == "opencode" => {
                if let Some(coerced) = coerce_agent_plan_from_raw(&raw) {
                    coerced
                } else {
                    return Err(format!(
                        "{label} JSON invalid: {}",
                        compact_cli_parse_error(&err)
                    ));
                }
            }
            Err(err) => {
                return Err(format!(
                    "{label} JSON invalid: {}",
                    compact_cli_parse_error(&err)
                ))
            }
        };

        outputs.push(NamedAgentPlan {
            id: agent.id.clone(),
            label: agent.label.clone(),
            cli: agent.cli.clone(),
            plan,
        });
    }

    Ok(outputs)
}

pub async fn generate_candidate_via_cli(
    agent_a_cli: &str,
    requirement: &str,
    clarifications: &str,
    decision: &str,
    worktree_path: &str,
    runtime_config: Option<&RuntimeConfigInput>,
    phase12_run_context: Option<&Phase12CliRunContext>,
) -> Result<String, String> {
    let prompt = format!(
        "{AGENT_A_CLI_PROMPT}\n\nRequirement:\n{requirement}\n\nClarifications:\n{clarifications}\n\nHuman decision:\n{decision}\n"
    );
    let phase12_agent_context = phase12_run_context.map(|context| Phase12CliAgentContext {
        request_id: context.request_id.clone(),
        phase: context.phase,
        agent_id: "phase3_agent_a".to_string(),
        agent_label: "Agent A · Architect".to_string(),
        agent_cli: agent_a_cli.to_string(),
        emitter: Arc::clone(&context.emitter),
        legacy_phase12_emitter: context.legacy_phase12_emitter.clone(),
    });
    let raw = run_agent_cli(
        agent_a_cli,
        Some("phase3_agent_a"),
        &prompt,
        worktree_path,
        Some(worktree_path),
        "Agent A CLI generation",
        runtime_config,
        CliExecutionIsolationMode::SharedWorktree,
        phase12_agent_context.as_ref(),
    )
    .await?;

    let code = extract_code_block(&raw);
    if code.trim().is_empty() {
        return Err("Agent A CLI returned empty code output".to_string());
    }

    Ok(code)
}

pub fn resolve_agent_a_cli(selection: Option<&str>) -> Result<String, String> {
    resolve_agent_cli(selection, "claude", "Agent A")
}

pub fn resolve_reviewer_cli(selection: Option<&str>) -> Result<String, String> {
    resolve_agent_cli(
        selection
            .map(str::to_string)
            .or_else(|| env::var("FRICTION_PHASE3_AGENT_B_CLI").ok())
            .as_deref(),
        "codex",
        "Agent B",
    )
}

fn resolve_agent_cli(
    selection: Option<&str>,
    default_value: &str,
    label: &str,
) -> Result<String, String> {
    let value = selection
        .map(str::to_string)
        .unwrap_or_else(|| default_value.to_string())
        .to_lowercase();

    match value.as_str() {
        "claude" => Ok("claude".to_string()),
        "codex" => Ok("codex".to_string()),
        "gemini" => Ok("gemini".to_string()),
        "opencode" => Ok("opencode".to_string()),
        unsupported => Err(format!(
            "Unsupported {label} CLI '{unsupported}'. Use claude|codex|gemini|opencode."
        )),
    }
}

pub fn diagnose_phase_agents_cli(
    phase_agents: &[ResolvedPhaseAgent],
    runtime_config: Option<&RuntimeConfigInput>,
) -> Result<Phase12CliDiagnosticsOutput, String> {
    let mut agents = Vec::with_capacity(phase_agents.len());
    for agent in phase_agents {
        let resolution = resolve_cli_command(&agent.cli, runtime_config)?;
        let resolved_binary_path = resolve_binary_path(&resolution.command);
        let resolved_family = infer_cli_family(&resolution.command);
        let model_resolution =
            resolve_agent_cli_model(runtime_config, Some(agent.id.as_str()), &agent.cli);
        let (runtime_ready, readiness_reason, readiness_source, requires_auth) =
            match agent.cli.as_str() {
                "codex" => {
                    let readiness = determine_codex_runtime_readiness();
                    (
                        readiness.runtime_ready,
                        readiness.readiness_reason,
                        readiness.readiness_source,
                        true,
                    )
                }
                "gemini" => {
                    let readiness = determine_gemini_runtime_readiness();
                    (
                        readiness.runtime_ready,
                        readiness.readiness_reason,
                        readiness.readiness_source,
                        true,
                    )
                }
                _ => (true, None, "none".to_string(), false),
            };
        agents.push(PhaseAgentCliDiagnostic {
            id: agent.id.clone(),
            label: agent.label.clone(),
            selected_cli: agent.cli.clone(),
            resolved_command: resolution.command,
            resolved_command_source: resolution.source,
            resolved_binary_path,
            resolved_family,
            resolved_model: model_resolution.model,
            resolved_model_source: model_resolution.source,
            runtime_ready,
            readiness_reason,
            readiness_source,
            requires_auth,
        });
    }
    Ok(Phase12CliDiagnosticsOutput { agents })
}

pub async fn list_opencode_models(
    runtime_config: Option<&RuntimeConfigInput>,
) -> Result<Vec<String>, String> {
    list_opencode_models_with_refresh(runtime_config, false).await
}

async fn list_opencode_models_with_refresh(
    runtime_config: Option<&RuntimeConfigInput>,
    force_refresh: bool,
) -> Result<Vec<String>, String> {
    let command_resolution = resolve_cli_command("opencode", runtime_config)?;
    let command = command_resolution.command;
    let command_source = command_resolution.source;
    let resolved_binary_path = resolve_binary_path(&command);
    let output = match run_opencode_models_command(
        &command,
        &command_source,
        resolved_binary_path.as_deref(),
        force_refresh,
        CliExecutionIsolationMode::SharedWorktree,
    )
    .await
    {
        Ok(output) => output,
        Err(primary_err) => {
            if !is_opencode_invalid_config_error(&primary_err) {
                return Err(primary_err);
            }
            run_opencode_models_command(
                &command,
                &command_source,
                resolved_binary_path.as_deref(),
                force_refresh,
                CliExecutionIsolationMode::StrictPhase12,
            )
            .await
            .map_err(|fallback_err| {
                format!("{primary_err}. Retry with isolated OpenCode config failed: {fallback_err}")
            })?
        }
    };

    let models = parse_opencode_models_output(&output.stdout, &output.stderr);
    if models.is_empty() {
        let raw = if output.stdout.trim().is_empty() {
            output.stderr.trim().to_string()
        } else {
            output.stdout.trim().to_string()
        };
        if raw.is_empty() {
            return Err("OpenCode model listing returned no output.".to_string());
        }
        return Err(format!(
            "OpenCode model listing returned no parseable model identifiers. Raw: {}",
            truncate(&raw, 320)
        ));
    }

    Ok(models)
}

pub async fn list_cli_models(
    cli_alias: &str,
    runtime_config: Option<&RuntimeConfigInput>,
    force_refresh: bool,
) -> Result<CliModelsListOutput, String> {
    let alias = resolve_agent_cli(Some(cli_alias), "claude", "CLI model listing")?;
    let command_resolution = resolve_cli_command(alias.as_str(), runtime_config)?;
    let provider_fingerprint = cli_models_provider_cache_segment(alias.as_str(), runtime_config)
        .unwrap_or_else(|err| format!("provider_unknown:{err}"));
    let cache_key = cli_models_cache_key(
        alias.as_str(),
        command_resolution.command.as_str(),
        command_resolution.source.as_str(),
        provider_fingerprint.as_str(),
    );

    let previous_cache = read_cli_models_cache(cache_key.as_str());
    if !force_refresh {
        if let Some(cached) = previous_cache.as_ref() {
            let age_seconds = (Utc::now() - cached.updated_at).num_seconds();
            if age_seconds >= 0 && age_seconds <= CLI_MODELS_CACHE_FRESH_SECS {
                return Ok(CliModelsListOutput {
                    models: cached.models.clone(),
                    source: "cache".to_string(),
                    reason: cached.reason.clone(),
                    stale: false,
                    last_updated_at: Some(cached.updated_at.to_rfc3339()),
                    provider_mode: cached.provider_mode.clone(),
                });
            }

            if age_seconds >= 0 && age_seconds <= CLI_MODELS_CACHE_HARD_SECS {
                spawn_cli_models_background_refresh(
                    alias.clone(),
                    runtime_config.cloned(),
                    cache_key.clone(),
                );
                return Ok(CliModelsListOutput {
                    models: cached.models.clone(),
                    source: "cache".to_string(),
                    reason: cached.reason.clone(),
                    stale: true,
                    last_updated_at: Some(cached.updated_at.to_rfc3339()),
                    provider_mode: cached.provider_mode.clone(),
                });
            }
        }
    }

    let fetched =
        fetch_cli_models_live_or_fallback(alias.as_str(), runtime_config, force_refresh).await;

    if should_preserve_cached_live_inventory_on_fallback(&fetched, previous_cache.as_ref()) {
        if let Some(cached_live) = previous_cache {
            let reason = merge_fallback_reason_with_cached_live(
                cached_live.reason.as_deref(),
                fetched.reason.as_deref(),
            );
            write_cli_models_cache(
                cache_key.as_str(),
                CliModelsCacheEntry {
                    models: cached_live.models.clone(),
                    source: cached_live.source.clone(),
                    reason: reason.clone(),
                    provider_mode: cached_live.provider_mode.clone(),
                    updated_at: cached_live.updated_at,
                },
            );
            return Ok(CliModelsListOutput {
                models: cached_live.models,
                source: "cache".to_string(),
                reason,
                stale: true,
                last_updated_at: Some(cached_live.updated_at.to_rfc3339()),
                provider_mode: cached_live.provider_mode,
            });
        }
    }

    let updated_at = Utc::now();
    write_cli_models_cache(
        cache_key.as_str(),
        CliModelsCacheEntry {
            models: fetched.models.clone(),
            source: fetched.source.clone(),
            reason: fetched.reason.clone(),
            provider_mode: fetched.provider_mode.clone(),
            updated_at,
        },
    );

    Ok(CliModelsListOutput {
        models: fetched.models,
        source: fetched.source,
        reason: fetched.reason,
        stale: false,
        last_updated_at: Some(updated_at.to_rfc3339()),
        provider_mode: fetched.provider_mode,
    })
}

fn cli_models_cache_key(
    alias: &str,
    command: &str,
    command_source: &str,
    provider_segment: &str,
) -> String {
    format!("{alias}|{command_source}|{command}|{provider_segment}")
}

fn cli_models_cache() -> &'static Mutex<HashMap<String, CliModelsCacheEntry>> {
    CLI_MODELS_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cli_models_refresh_inflight() -> &'static Mutex<HashSet<String>> {
    CLI_MODELS_REFRESH_INFLIGHT.get_or_init(|| Mutex::new(HashSet::new()))
}

fn read_cli_models_cache(cache_key: &str) -> Option<CliModelsCacheEntry> {
    cli_models_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(cache_key).cloned())
}

fn write_cli_models_cache(cache_key: &str, entry: CliModelsCacheEntry) {
    if let Ok(mut cache) = cli_models_cache().lock() {
        cache.insert(cache_key.to_string(), entry);
    }
}

fn mark_cli_models_refresh_inflight(cache_key: &str) -> bool {
    if let Ok(mut inflight) = cli_models_refresh_inflight().lock() {
        if inflight.contains(cache_key) {
            return false;
        }
        inflight.insert(cache_key.to_string());
        return true;
    }
    false
}

fn clear_cli_models_refresh_inflight(cache_key: &str) {
    if let Ok(mut inflight) = cli_models_refresh_inflight().lock() {
        inflight.remove(cache_key);
    }
}

fn spawn_cli_models_background_refresh(
    alias: String,
    runtime_config: Option<RuntimeConfigInput>,
    cache_key: String,
) {
    if !mark_cli_models_refresh_inflight(cache_key.as_str()) {
        return;
    }

    tokio::spawn(async move {
        let previous_cache = read_cli_models_cache(cache_key.as_str());
        let refreshed =
            fetch_cli_models_live_or_fallback(alias.as_str(), runtime_config.as_ref(), false).await;
        if should_preserve_cached_live_inventory_on_fallback(&refreshed, previous_cache.as_ref()) {
            if let Some(cached_live) = previous_cache {
                let reason = merge_fallback_reason_with_cached_live(
                    cached_live.reason.as_deref(),
                    refreshed.reason.as_deref(),
                );
                write_cli_models_cache(
                    cache_key.as_str(),
                    CliModelsCacheEntry {
                        models: cached_live.models,
                        source: cached_live.source.clone(),
                        reason,
                        provider_mode: cached_live.provider_mode.clone(),
                        updated_at: cached_live.updated_at,
                    },
                );
                clear_cli_models_refresh_inflight(cache_key.as_str());
                return;
            }
        }
        let updated_at = Utc::now();
        write_cli_models_cache(
            cache_key.as_str(),
            CliModelsCacheEntry {
                models: refreshed.models,
                source: refreshed.source,
                reason: refreshed.reason,
                provider_mode: refreshed.provider_mode,
                updated_at,
            },
        );
        clear_cli_models_refresh_inflight(cache_key.as_str());
    });
}

fn should_preserve_cached_live_inventory_on_fallback(
    fetched: &CliModelsFetchResult,
    previous_cache: Option<&CliModelsCacheEntry>,
) -> bool {
    fetched.source == "fallback"
        && previous_cache
            .map(|cached| cached.source == "live" && !cached.models.is_empty())
            .unwrap_or(false)
}

fn merge_fallback_reason_with_cached_live(
    previous_reason: Option<&str>,
    fallback_reason: Option<&str>,
) -> Option<String> {
    let mut parts = Vec::<String>::new();
    if let Some(reason) = fallback_reason
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
    {
        parts.push(reason.to_string());
    }
    parts.push("served cached live inventory".to_string());
    if let Some(reason) = previous_reason
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
    {
        parts.push(format!("previous cache note: {reason}"));
    }
    Some(parts.join(" | "))
}

async fn fetch_cli_models_live_or_fallback(
    alias: &str,
    runtime_config: Option<&RuntimeConfigInput>,
    force_refresh: bool,
) -> CliModelsFetchResult {
    let fallback_models = default_models_for_cli(alias);
    let provider_mode_hint = cli_models_provider_cache_segment(alias, runtime_config).ok();

    if alias == "opencode" {
        return match list_opencode_models_with_refresh(runtime_config, force_refresh).await {
            Ok(models) if !models.is_empty() => CliModelsFetchResult {
                models,
                source: "live".to_string(),
                reason: None,
                provider_mode: Some("opencode-cli".to_string()),
            },
            Ok(_) => CliModelsFetchResult {
                models: fallback_models,
                source: "fallback".to_string(),
                reason: Some(
                    "OpenCode live inventory unavailable; using fallback presets.".to_string(),
                ),
                provider_mode: Some("opencode-cli".to_string()),
            },
            Err(err) => CliModelsFetchResult {
                models: fallback_models,
                source: "fallback".to_string(),
                reason: Some(concise_inventory_fallback_reason(alias, err.as_str())),
                provider_mode: Some("opencode-cli".to_string()),
            },
        };
    }

    let command_resolution = match resolve_cli_command(alias, runtime_config) {
        Ok(value) => value,
        Err(err) => {
            return CliModelsFetchResult {
                models: fallback_models,
                source: "fallback".to_string(),
                reason: Some(concise_inventory_fallback_reason(alias, err.as_str())),
                provider_mode: provider_mode_hint.clone(),
            };
        }
    };
    let resolved_binary_path = resolve_binary_path(command_resolution.command.as_str());
    if resolved_binary_path.is_none() {
        return CliModelsFetchResult {
            models: fallback_models,
            source: "fallback".to_string(),
            reason: Some(concise_inventory_fallback_reason(
                alias,
                format!(
                    "resolved command '{}' ({}) is not available in PATH",
                    command_resolution.command, command_resolution.source
                )
                .as_str(),
            )),
            provider_mode: provider_mode_hint.clone(),
        };
    }

    let live_result = fetch_cli_models_live(alias, runtime_config).await;

    match live_result {
        Ok(result) if !result.models.is_empty() => CliModelsFetchResult {
            models: result.models,
            source: "live".to_string(),
            reason: None,
            provider_mode: Some(result.mode),
        },
        Ok(result) => CliModelsFetchResult {
            models: fallback_models,
            source: "fallback".to_string(),
            reason: Some(format!(
                "{} live inventory unavailable; using fallback presets.",
                cli_label(alias)
            )),
            provider_mode: Some(result.mode),
        },
        Err(err) => CliModelsFetchResult {
            models: fallback_models,
            source: "fallback".to_string(),
            reason: Some(concise_inventory_fallback_reason(alias, err.as_str())),
            provider_mode: provider_mode_hint,
        },
    }
}

fn concise_inventory_fallback_reason(alias: &str, detail: &str) -> String {
    let lowered = detail.trim().to_ascii_lowercase();
    let label = cli_label(alias);

    if lowered.contains("missing")
        && (lowered.contains("api_key")
            || lowered.contains("access_token")
            || lowered.contains("credential")
            || lowered.contains("auth"))
    {
        return format!("{label} credentials missing; using fallback presets.");
    }

    if lowered.contains("not available in path")
        || lowered.contains("command")
            && (lowered.contains("not found") || lowered.contains("not available"))
    {
        return format!("{label} CLI unavailable; using fallback presets.");
    }

    if lowered.contains("timed out")
        || lowered.contains("timeout")
        || lowered.contains("deadline has elapsed")
    {
        return format!("{label} inventory timed out; using fallback presets.");
    }

    if lowered.contains("returned no models") || lowered.contains("returned no output") {
        return format!("{label} live inventory unavailable; using fallback presets.");
    }

    format!(
        "{label} live inventory unavailable; using fallback presets. ({})",
        truncate(detail.trim(), 120)
    )
}

async fn fetch_cli_models_live(
    alias: &str,
    runtime_config: Option<&RuntimeConfigInput>,
) -> Result<CliModelsLiveResult, String> {
    match alias {
        "codex" => fetch_codex_models_live(runtime_config).await,
        "claude" => fetch_claude_models_live().await,
        "gemini" => fetch_gemini_models_live().await,
        _ => Err(format!(
            "Unsupported CLI '{}' for live model inventory.",
            cli_label(alias)
        )),
    }
}

fn cli_models_provider_cache_segment(
    alias: &str,
    runtime_config: Option<&RuntimeConfigInput>,
) -> Result<String, String> {
    match alias {
        "opencode" => Ok("provider:opencode".to_string()),
        "gemini" => Ok(gemini_inventory_mode_hint()),
        "claude" => Ok(claude_inventory_mode_hint()),
        "codex" => Ok(codex_inventory_mode_hint(runtime_config)?),
        _ => Ok(format!("provider:{}", cli_label(alias).to_lowercase())),
    }
}

fn env_non_empty(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_non_empty_with_source(keys: &[&str]) -> Option<(String, String)> {
    keys.iter().find_map(|key| {
        env_non_empty(key)
            .map(|value| (value, format!("env:{key}")))
            .filter(|(value, _)| !value.trim().is_empty())
    })
}

fn env_truthy_with_source(keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        env_non_empty(key)
            .filter(|value| is_truthy_env_value(value))
            .map(|_| format!("env:{key}"))
    })
}

fn is_truthy_env_value(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn model_inventory_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(CLI_MODELS_HTTP_CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(cli_models_http_timeout_secs()))
        .build()
        .map_err(|err| format!("failed to initialize model inventory HTTP client: {err}"))
}

fn cli_models_http_timeout_secs() -> u64 {
    env::var("FRICTION_CLI_MODELS_HTTP_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(CLI_MODELS_HTTP_TIMEOUT_SECS)
}

async fn fetch_openai_models_from_api(api_key: &str) -> Result<Vec<String>, String> {
    fetch_openai_models_from_endpoint(
        "https://api.openai.com/v1/models",
        api_key,
        Some(is_codex_or_openai_model_id),
    )
    .await
}

async fn fetch_openai_models_from_endpoint(
    endpoint: &str,
    api_key: &str,
    model_filter: Option<fn(&str) -> bool>,
) -> Result<Vec<String>, String> {
    let client = model_inventory_http_client()?;
    let response = client
        .get(endpoint)
        .header(AUTHORIZATION, format!("Bearer {api_key}"))
        .send()
        .await
        .map_err(|err| format!("OpenAI-compatible models request failed: {err}"))?;
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|err| format!("OpenAI-compatible models JSON decode failed: {err}"))?;
    if !status.is_success() {
        return Err(format!(
            "OpenAI-compatible models request failed ({status}): {payload}"
        ));
    }
    let models = payload
        .get("data")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(Value::as_str))
                .map(str::trim)
                .filter(|value| model_filter.map(|filter| filter(value)).unwrap_or(true))
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(dedupe_sort_models(models))
}

fn openai_models_endpoint_from_base(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return "https://api.openai.com/v1/models".to_string();
    }
    if trimmed.ends_with("/models") {
        return trimmed.to_string();
    }
    format!("{trimmed}/models")
}

fn is_codex_or_openai_model_id(value: &str) -> bool {
    let lower = value.to_lowercase();
    if lower.is_empty() {
        return false;
    }
    lower.contains("codex")
        || lower.starts_with("gpt-")
        || lower.starts_with("o1")
        || lower.starts_with("o3")
        || lower.starts_with("o4")
}

async fn fetch_codex_models_live(
    runtime_config: Option<&RuntimeConfigInput>,
) -> Result<CliModelsLiveResult, String> {
    if let Some(models) = read_codex_models_from_local_cache() {
        if !models.is_empty() {
            return Ok(CliModelsLiveResult {
                models,
                mode: "codex-local-cache".to_string(),
            });
        }
    }

    let selected_provider = resolve_codex_selected_provider_name(runtime_config);
    if selected_provider.0 == "openai" {
        let base_url_override =
            env_non_empty("OPENAI_BASE_URL").or_else(|| env_non_empty("OPENAI_API_BASE"));
        let api_key = env_non_empty("OPENAI_API_KEY").ok_or(
            "mode=openai OPENAI_API_KEY is missing; live Codex model listing is unavailable."
                .to_string(),
        )?;
        let models = if let Some(base_url) = base_url_override {
            let endpoint = openai_models_endpoint_from_base(base_url.as_str());
            fetch_openai_models_from_endpoint(
                endpoint.as_str(),
                api_key.as_str(),
                Some(is_codex_or_openai_model_id),
            )
            .await?
        } else {
            fetch_openai_models_from_api(api_key.as_str()).await?
        };
        return Ok(CliModelsLiveResult {
            models,
            mode: "openai".to_string(),
        });
    }

    let (config_path, config) = read_codex_config_toml().ok_or_else(|| {
        format!(
            "mode=codex-provider:{} selected via {} but no Codex config was found.",
            selected_provider.0, selected_provider.1
        )
    })?;
    let provider_entry = codex_provider_entry_from_config(&config, selected_provider.0.as_str())
        .ok_or_else(|| {
            format!(
                "mode=codex-provider:{} provider entry missing under model_providers in {}.",
                selected_provider.0,
                config_path.to_string_lossy()
            )
        })?;

    let endpoint = openai_models_endpoint_from_base(provider_entry.base_url.as_str());
    let env_key = provider_entry
        .env_key
        .unwrap_or_else(|| "OPENAI_API_KEY".to_string());
    let api_key = env_non_empty(env_key.as_str()).ok_or_else(|| {
        format!(
            "mode=codex-provider:{} {} is missing; live listing is unavailable.",
            provider_entry.name, env_key
        )
    })?;
    let models =
        fetch_openai_models_from_endpoint(endpoint.as_str(), api_key.as_str(), None).await?;
    Ok(CliModelsLiveResult {
        models,
        mode: format!("codex-provider:{}", provider_entry.name),
    })
}

fn codex_inventory_mode_hint(
    runtime_config: Option<&RuntimeConfigInput>,
) -> Result<String, String> {
    let selected_provider = resolve_codex_selected_provider_name(runtime_config);
    if selected_provider.0 == "openai" {
        let base_url = env_non_empty("OPENAI_BASE_URL")
            .or_else(|| env_non_empty("OPENAI_API_BASE"))
            .unwrap_or_else(|| "https://api.openai.com/v1".to_string());
        let endpoint = openai_models_endpoint_from_base(base_url.as_str());
        return Ok(format!(
            "provider:openai|source:{}|endpoint:{}",
            selected_provider.1, endpoint
        ));
    }
    let (config_path, config) = read_codex_config_toml().ok_or_else(|| {
        format!(
            "codex_provider_config_missing:{}:{}",
            selected_provider.0, selected_provider.1
        )
    })?;
    let provider_entry = codex_provider_entry_from_config(&config, selected_provider.0.as_str())
        .ok_or_else(|| {
            format!(
                "codex_provider_entry_missing:{}:{}",
                selected_provider.0,
                config_path.to_string_lossy()
            )
        })?;
    Ok(format!(
        "provider:{}|source:{}|endpoint:{}",
        provider_entry.name, selected_provider.1, provider_entry.base_url
    ))
}

fn resolve_codex_selected_provider_name(
    _runtime_config: Option<&RuntimeConfigInput>,
) -> (String, String) {
    if let Some(value) = env_non_empty("CODEX_MODEL_PROVIDER") {
        return (value, "env:CODEX_MODEL_PROVIDER".to_string());
    }
    if let Some((_, config)) = read_codex_config_toml() {
        if let Some(model_provider) = codex_model_provider_from_config(&config) {
            return (model_provider, "config:model_provider".to_string());
        }
    }
    ("openai".to_string(), "default:openai".to_string())
}

fn resolve_codex_config_path_for_inventory() -> Option<PathBuf> {
    if let Some(codex_home) = env_non_empty("CODEX_HOME") {
        return Some(PathBuf::from(codex_home).join("config.toml"));
    }
    dirs::home_dir().map(|home| home.join(".codex").join("config.toml"))
}

fn resolve_codex_models_cache_path_for_inventory() -> Option<PathBuf> {
    if let Some(codex_home) = env_non_empty("CODEX_HOME") {
        return Some(PathBuf::from(codex_home).join("models_cache.json"));
    }
    dirs::home_dir().map(|home| home.join(".codex").join("models_cache.json"))
}

fn read_codex_models_from_local_cache() -> Option<Vec<String>> {
    let path = resolve_codex_models_cache_path_for_inventory()?;
    let content = fs::read_to_string(path).ok()?;
    parse_codex_models_cache_content(content.as_str()).ok()
}

fn parse_codex_models_cache_content(content: &str) -> Result<Vec<String>, String> {
    let payload: Value =
        serde_json::from_str(content).map_err(|err| format!("invalid codex cache JSON: {err}"))?;
    let models = payload
        .get("models")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    item.get("slug")
                        .and_then(Value::as_str)
                        .or_else(|| item.get("id").and_then(Value::as_str))
                })
                .map(str::trim)
                .filter(|model| !model.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(dedupe_sort_models(models))
}

fn read_codex_config_toml() -> Option<(PathBuf, toml::Value)> {
    let path = resolve_codex_config_path_for_inventory()?;
    let content = fs::read_to_string(&path).ok()?;
    let parsed = toml::from_str::<toml::Value>(content.as_str()).ok()?;
    Some((path, parsed))
}

fn codex_model_provider_from_config(config: &toml::Value) -> Option<String> {
    config
        .get("model_provider")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn codex_provider_entry_from_config(
    config: &toml::Value,
    provider_name: &str,
) -> Option<CodexProviderConfigEntry> {
    let providers = config.get("model_providers")?.as_table()?;
    let provider = providers.get(provider_name)?.as_table()?;
    let base_url = provider
        .get("base_url")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    let env_key = provider
        .get("env_key")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Some(CodexProviderConfigEntry {
        name: provider_name.to_string(),
        base_url,
        env_key,
    })
}

#[derive(Debug, Clone)]
enum ClaudeInventoryMode {
    Anthropic {
        api_key: String,
        source: String,
    },
    Vertex {
        project: String,
        location: String,
        access_token: String,
        source: String,
    },
    Bedrock {
        source: String,
    },
}

fn resolve_claude_inventory_mode() -> Result<ClaudeInventoryMode, String> {
    if let Some(source) =
        env_truthy_with_source(&["CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_USE_BEDROCK"])
    {
        return Ok(ClaudeInventoryMode::Bedrock { source });
    }
    if let Some(source) =
        env_truthy_with_source(&["CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_VERTEX_AI"])
    {
        let (project, location, access_token) = resolve_vertex_project_location_and_token()?;
        return Ok(ClaudeInventoryMode::Vertex {
            project,
            location,
            access_token,
            source,
        });
    }

    if let Some((api_key, source)) = env_non_empty_with_source(&["ANTHROPIC_API_KEY"]) {
        return Ok(ClaudeInventoryMode::Anthropic { api_key, source });
    }

    let has_aws_auth = env_non_empty("AWS_ACCESS_KEY_ID").is_some()
        || env_non_empty("AWS_PROFILE").is_some()
        || env_non_empty("AWS_WEB_IDENTITY_TOKEN_FILE").is_some();
    if has_aws_auth {
        return Ok(ClaudeInventoryMode::Bedrock {
            source: "env:aws_credentials".to_string(),
        });
    }

    if env_non_empty("GOOGLE_CLOUD_PROJECT").is_some() {
        let (project, location, access_token) = resolve_vertex_project_location_and_token()?;
        return Ok(ClaudeInventoryMode::Vertex {
            project,
            location,
            access_token,
            source: "env:GOOGLE_CLOUD_PROJECT".to_string(),
        });
    }

    Err(
        "mode=unknown ANTHROPIC_API_KEY is missing and no Bedrock/Vertex runtime was detected."
            .to_string(),
    )
}

fn claude_inventory_mode_hint() -> String {
    if let Some(source) =
        env_truthy_with_source(&["CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_USE_BEDROCK"])
    {
        return format!("provider:bedrock|source:{source}");
    }
    if let Some(source) =
        env_truthy_with_source(&["CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_VERTEX_AI"])
    {
        let project =
            env_non_empty("GOOGLE_CLOUD_PROJECT").unwrap_or_else(|| "unknown".to_string());
        let location = env_non_empty("GOOGLE_CLOUD_LOCATION")
            .or_else(|| env_non_empty("CLOUD_ML_REGION"))
            .unwrap_or_else(|| "us-central1".to_string());
        return format!("provider:vertex|source:{source}|project:{project}|location:{location}");
    }
    if let Some((_, source)) = env_non_empty_with_source(&["ANTHROPIC_API_KEY"]) {
        return format!("provider:anthropic|source:{source}");
    }
    if env_non_empty("AWS_ACCESS_KEY_ID").is_some()
        || env_non_empty("AWS_PROFILE").is_some()
        || env_non_empty("AWS_WEB_IDENTITY_TOKEN_FILE").is_some()
    {
        return "provider:bedrock|source:env:aws_credentials".to_string();
    }
    "provider:anthropic|source:missing_credentials".to_string()
}

async fn fetch_claude_models_live() -> Result<CliModelsLiveResult, String> {
    if let Some(models) = read_claude_models_from_local_usage() {
        if !models.is_empty() {
            return Ok(CliModelsLiveResult {
                models,
                mode: "claude-local-usage".to_string(),
            });
        }
    }

    let mode = resolve_claude_inventory_mode()?;
    match mode {
        ClaudeInventoryMode::Anthropic { api_key, source } => {
            let models = fetch_anthropic_models_from_api(api_key.as_str()).await?;
            Ok(CliModelsLiveResult {
                models,
                mode: format!("anthropic:{source}"),
            })
        }
        ClaudeInventoryMode::Vertex {
            project,
            location,
            access_token,
            source,
        } => {
            let models = fetch_vertex_models_for_publisher(
                project.as_str(),
                location.as_str(),
                "anthropic",
                access_token.as_str(),
                "claude-",
            )
            .await?;
            Ok(CliModelsLiveResult {
                models,
                mode: format!("vertex:{source}"),
            })
        }
        ClaudeInventoryMode::Bedrock { source } => {
            let models = fetch_claude_models_from_bedrock_via_aws_cli().await?;
            Ok(CliModelsLiveResult {
                models,
                mode: format!("bedrock:{source}"),
            })
        }
    }
}

fn resolve_claude_state_path_for_inventory() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".claude.json"))
}

fn read_claude_models_from_local_usage() -> Option<Vec<String>> {
    let path = resolve_claude_state_path_for_inventory()?;
    let content = fs::read_to_string(path).ok()?;
    parse_claude_models_from_local_usage(content.as_str()).ok()
}

fn parse_claude_models_from_local_usage(content: &str) -> Result<Vec<String>, String> {
    let payload: Value =
        serde_json::from_str(content).map_err(|err| format!("invalid claude state JSON: {err}"))?;
    let mut models = Vec::<String>::new();
    collect_claude_models_from_last_usage(&payload, &mut models);
    Ok(dedupe_sort_models(models))
}

fn collect_claude_models_from_last_usage(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, nested) in map {
                if key == "lastModelUsage" {
                    if let Some(usage) = nested.as_object() {
                        for model_id in usage.keys() {
                            let trimmed = model_id.trim();
                            if trimmed.starts_with("claude-") && !trimmed.is_empty() {
                                out.push(trimmed.to_string());
                            }
                        }
                    }
                }
                collect_claude_models_from_last_usage(nested, out);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_claude_models_from_last_usage(item, out);
            }
        }
        _ => {}
    }
}

#[derive(Debug, Clone)]
enum GeminiInventoryMode {
    DeveloperApi {
        api_key: String,
        source: String,
    },
    Vertex {
        project: String,
        location: String,
        access_token: String,
        source: String,
    },
}

fn resolve_gemini_inventory_mode() -> Result<GeminiInventoryMode, String> {
    let explicit_vertex = env_truthy_with_source(&[
        "GOOGLE_GENAI_USE_VERTEXAI",
        "GEMINI_USE_VERTEXAI",
        "VERTEXAI",
    ]);
    let api_key = env_non_empty_with_source(&[
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
    ]);

    if explicit_vertex.is_some() {
        let (project, location, access_token) = resolve_vertex_project_location_and_token()?;
        return Ok(GeminiInventoryMode::Vertex {
            project,
            location,
            access_token,
            source: explicit_vertex.unwrap_or_else(|| "env:vertex".to_string()),
        });
    }

    if let Some((api_key, source)) = api_key {
        return Ok(GeminiInventoryMode::DeveloperApi { api_key, source });
    }

    if env_non_empty("GOOGLE_CLOUD_PROJECT").is_some() {
        let (project, location, access_token) = resolve_vertex_project_location_and_token()?;
        return Ok(GeminiInventoryMode::Vertex {
            project,
            location,
            access_token,
            source: "env:GOOGLE_CLOUD_PROJECT".to_string(),
        });
    }

    Err(
        "mode=unknown GEMINI_API_KEY/GOOGLE_API_KEY is missing and no Vertex runtime was detected."
            .to_string(),
    )
}

fn gemini_inventory_mode_hint() -> String {
    if let Some(source) = env_truthy_with_source(&[
        "GOOGLE_GENAI_USE_VERTEXAI",
        "GEMINI_USE_VERTEXAI",
        "VERTEXAI",
    ]) {
        let project =
            env_non_empty("GOOGLE_CLOUD_PROJECT").unwrap_or_else(|| "unknown".to_string());
        let location = env_non_empty("GOOGLE_CLOUD_LOCATION")
            .or_else(|| env_non_empty("CLOUD_ML_REGION"))
            .unwrap_or_else(|| "us-central1".to_string());
        return format!("provider:vertex|source:{source}|project:{project}|location:{location}");
    }
    if let Some((_, source)) = env_non_empty_with_source(&[
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
    ]) {
        return format!("provider:google-api|source:{source}");
    }
    if env_non_empty("GOOGLE_CLOUD_PROJECT").is_some() {
        let project =
            env_non_empty("GOOGLE_CLOUD_PROJECT").unwrap_or_else(|| "unknown".to_string());
        let location = env_non_empty("GOOGLE_CLOUD_LOCATION")
            .or_else(|| env_non_empty("CLOUD_ML_REGION"))
            .unwrap_or_else(|| "us-central1".to_string());
        return format!(
            "provider:vertex|source:env:GOOGLE_CLOUD_PROJECT|project:{project}|location:{location}"
        );
    }
    "provider:google-api|source:missing_credentials".to_string()
}

async fn fetch_gemini_models_live() -> Result<CliModelsLiveResult, String> {
    if let Some(models) = read_gemini_models_from_local_usage() {
        if !models.is_empty() {
            return Ok(CliModelsLiveResult {
                models,
                mode: "gemini-local-usage".to_string(),
            });
        }
    }

    let mode = resolve_gemini_inventory_mode()?;
    match mode {
        GeminiInventoryMode::DeveloperApi { api_key, source } => {
            let models = fetch_gemini_models_from_api(api_key.as_str()).await?;
            Ok(CliModelsLiveResult {
                models,
                mode: format!("google-api:{source}"),
            })
        }
        GeminiInventoryMode::Vertex {
            project,
            location,
            access_token,
            source,
        } => {
            let models = fetch_vertex_models_for_publisher(
                project.as_str(),
                location.as_str(),
                "google",
                access_token.as_str(),
                "gemini-",
            )
            .await?;
            Ok(CliModelsLiveResult {
                models,
                mode: format!("vertex:{source}"),
            })
        }
    }
}

fn resolve_gemini_tmp_root_for_inventory() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".gemini").join("tmp"))
}

fn read_gemini_models_from_local_usage() -> Option<Vec<String>> {
    let tmp_root = resolve_gemini_tmp_root_for_inventory()?;
    let files =
        collect_gemini_chat_session_files(tmp_root.as_path(), GEMINI_LOCAL_USAGE_SCAN_MAX_FILES)?;
    if files.is_empty() {
        return None;
    }

    let mut models = Vec::<String>::new();
    for path in files {
        if let Ok(content) = fs::read_to_string(path) {
            let parsed = parse_gemini_models_from_chat_content(content.as_str());
            if !parsed.is_empty() {
                models.extend(parsed);
            }
        }
    }
    let deduped = dedupe_sort_models(models);
    if deduped.is_empty() {
        None
    } else {
        Some(deduped)
    }
}

fn collect_gemini_chat_session_files(root: &Path, cap: usize) -> Option<Vec<PathBuf>> {
    if cap == 0 || !root.exists() {
        return None;
    }
    let mut pending = vec![root.to_path_buf()];
    let mut candidates = Vec::<(std::time::SystemTime, PathBuf)>::new();

    while let Some(dir) = pending.pop() {
        let entries = fs::read_dir(&dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
                continue;
            }
            let file_name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            if !file_name.starts_with("session-") || !file_name.ends_with(".json") {
                continue;
            }
            let path_str = path.to_string_lossy();
            if !path_str.contains("/chats/") {
                continue;
            }
            let modified = entry
                .metadata()
                .ok()
                .and_then(|meta| meta.modified().ok())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            candidates.push((modified, path));
        }
    }

    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    let selected = candidates
        .into_iter()
        .take(cap)
        .map(|(_, path)| path)
        .collect::<Vec<_>>();
    Some(selected)
}

fn parse_gemini_models_from_chat_content(content: &str) -> Vec<String> {
    let mut models = Vec::<String>::new();
    let payload = match serde_json::from_str::<Value>(content) {
        Ok(value) => value,
        Err(_) => return models,
    };
    collect_gemini_models_from_value(&payload, &mut models);
    dedupe_sort_models(models)
}

fn collect_gemini_models_from_value(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, nested) in map {
                if key == "model" {
                    if let Some(model_id) = nested.as_str() {
                        let trimmed = model_id.trim();
                        if trimmed.starts_with("gemini-") && !trimmed.is_empty() {
                            out.push(trimmed.to_string());
                        }
                    }
                }
                collect_gemini_models_from_value(nested, out);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_gemini_models_from_value(item, out);
            }
        }
        _ => {}
    }
}

fn resolve_vertex_project_location_and_token() -> Result<(String, String, String), String> {
    let (project, _project_source) =
        env_non_empty_with_source(&["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "VERTEX_PROJECT"])
            .ok_or(
                "Vertex model inventory requires GOOGLE_CLOUD_PROJECT (or GCLOUD_PROJECT)."
                    .to_string(),
            )?;
    let location = env_non_empty_with_source(&["GOOGLE_CLOUD_LOCATION", "CLOUD_ML_REGION"])
        .map(|(value, _)| value)
        .unwrap_or_else(|| "us-central1".to_string());
    let (access_token, _token_source) = env_non_empty_with_source(&[
        "GOOGLE_VERTEX_ACCESS_TOKEN",
        "GOOGLE_OAUTH_ACCESS_TOKEN",
        "GOOGLE_ACCESS_TOKEN",
    ])
    .ok_or(
        "Vertex model inventory requires GOOGLE_VERTEX_ACCESS_TOKEN (or GOOGLE_OAUTH_ACCESS_TOKEN / GOOGLE_ACCESS_TOKEN)."
            .to_string(),
    )?;
    Ok((project, location, access_token))
}

async fn fetch_vertex_models_for_publisher(
    project: &str,
    location: &str,
    publisher: &str,
    access_token: &str,
    required_prefix: &str,
) -> Result<Vec<String>, String> {
    let client = model_inventory_http_client()?;
    let endpoint = format!(
        "https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/{publisher}/models"
    );
    let response = client
        .get(endpoint)
        .header(AUTHORIZATION, format!("Bearer {access_token}"))
        .send()
        .await
        .map_err(|err| format!("Vertex models request failed: {err}"))?;
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|err| format!("Vertex models JSON decode failed: {err}"))?;
    if !status.is_success() {
        return Err(format!(
            "Vertex models request failed ({status}): {payload}"
        ));
    }

    let models = payload
        .get("models")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("name").and_then(Value::as_str))
                .filter_map(extract_vertex_model_id)
                .filter(|model| model.starts_with(required_prefix))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(dedupe_sort_models(models))
}

fn extract_vertex_model_id(name: &str) -> Option<String> {
    let normalized = name.trim();
    if normalized.is_empty() {
        return None;
    }
    let candidate = if let Some((_, suffix)) = normalized.rsplit_once("/models/") {
        suffix
    } else {
        normalized.strip_prefix("models/").unwrap_or(normalized)
    };
    let model = candidate.trim().trim_matches('/');
    if model.is_empty() {
        return None;
    }
    Some(model.to_string())
}

async fn fetch_claude_models_from_bedrock_via_aws_cli() -> Result<Vec<String>, String> {
    if resolve_binary_path("aws").is_none() {
        return Err(
            "mode=bedrock aws CLI is not available in PATH; cannot list Bedrock models."
                .to_string(),
        );
    }

    let mut command = TokioCommand::new("aws");
    command.kill_on_drop(true);
    command
        .arg("bedrock")
        .arg("list-foundation-models")
        .arg("--by-provider")
        .arg("anthropic")
        .arg("--output")
        .arg("json")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some((region, _)) = env_non_empty_with_source(&["AWS_REGION", "AWS_DEFAULT_REGION"]) {
        command.arg("--region").arg(region);
    }

    let output = command
        .output()
        .await
        .map_err(|err| format!("mode=bedrock failed to execute aws CLI: {err}"))?;
    let mut stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let mut stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if stdout.len() > CLI_MODELS_OUTPUT_MAX_BYTES {
        stdout = truncate(stdout.as_str(), CLI_MODELS_OUTPUT_MAX_BYTES);
    }
    if stderr.len() > CLI_MODELS_OUTPUT_MAX_BYTES {
        stderr = truncate(stderr.as_str(), CLI_MODELS_OUTPUT_MAX_BYTES);
    }

    if !output.status.success() {
        return Err(format!(
            "mode=bedrock aws CLI failed (status={}): {}",
            output.status.code().unwrap_or(-1),
            truncate(stderr.as_str(), 320)
        ));
    }

    let payload: Value = serde_json::from_str(stdout.as_str())
        .map_err(|err| format!("mode=bedrock invalid aws CLI JSON output: {err}"))?;
    let models = payload
        .get("modelSummaries")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("modelId").and_then(Value::as_str))
                .map(str::trim)
                .filter(|value| !value.is_empty() && value.contains("claude"))
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(dedupe_sort_models(models))
}

async fn fetch_anthropic_models_from_api(api_key: &str) -> Result<Vec<String>, String> {
    let client = model_inventory_http_client()?;
    let response = client
        .get("https://api.anthropic.com/v1/models")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map_err(|err| format!("Anthropic models request failed: {err}"))?;
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|err| format!("Anthropic models JSON decode failed: {err}"))?;
    if !status.is_success() {
        return Err(format!(
            "Anthropic models request failed ({status}): {payload}"
        ));
    }
    let models = payload
        .get("data")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(Value::as_str))
                .map(str::trim)
                .filter(|value| value.starts_with("claude-"))
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(dedupe_sort_models(models))
}

async fn fetch_gemini_models_from_api(api_key: &str) -> Result<Vec<String>, String> {
    let client = model_inventory_http_client()?;
    let endpoint = format!("https://generativelanguage.googleapis.com/v1beta/models?key={api_key}");
    let response = client
        .get(endpoint)
        .send()
        .await
        .map_err(|err| format!("Google models request failed: {err}"))?;
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|err| format!("Google models JSON decode failed: {err}"))?;
    if !status.is_success() {
        return Err(format!(
            "Google models request failed ({status}): {payload}"
        ));
    }
    let models = payload
        .get("models")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| supports_google_generation_model(item))
                .filter_map(|item| item.get("name").and_then(Value::as_str))
                .map(str::trim)
                .filter_map(|name| name.strip_prefix("models/").or(Some(name)))
                .filter(|value| value.starts_with("gemini-"))
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(dedupe_sort_models(models))
}

fn supports_google_generation_model(model: &Value) -> bool {
    let Some(methods) = model
        .get("supportedGenerationMethods")
        .and_then(Value::as_array)
    else {
        return true;
    };
    methods.iter().filter_map(Value::as_str).any(|method| {
        method.eq_ignore_ascii_case("generateContent")
            || method.eq_ignore_ascii_case("streamGenerateContent")
    })
}

fn dedupe_sort_models(models: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::<String>::new();
    let mut unique = Vec::<String>::new();
    for model in models {
        let normalized = model.trim();
        if normalized.is_empty() {
            continue;
        }
        let key = normalized.to_string();
        if seen.insert(key.clone()) {
            unique.push(key);
        }
    }
    unique.sort();
    unique
}

fn cli_label(alias: &str) -> &'static str {
    match alias {
        "opencode" => "OpenCode",
        "claude" => "Claude Code",
        "codex" => "Codex",
        "gemini" => "Gemini",
        _ => "CLI",
    }
}

fn default_models_for_cli(alias: &str) -> Vec<String> {
    match alias {
        "opencode" => vec![
            "openai/gpt-5-codex".to_string(),
            "ollama/llama3.2".to_string(),
        ],
        "claude" => vec![
            "claude-sonnet-4-5".to_string(),
            "claude-sonnet-4".to_string(),
            "claude-opus-4-1".to_string(),
        ],
        "codex" => vec![
            "gpt-5-codex".to_string(),
            "gpt-5.3-codex".to_string(),
            "o4-mini".to_string(),
        ],
        "gemini" => vec!["gemini-2.5-pro".to_string(), "gemini-2.5-flash".to_string()],
        _ => Vec::new(),
    }
}

async fn run_opencode_models_command(
    command: &str,
    command_source: &str,
    resolved_binary_path: Option<&str>,
    force_refresh: bool,
    isolation_mode: CliExecutionIsolationMode,
) -> Result<CliExecutionResult, String> {
    let execution_context = prepare_cli_execution_context(".", None, isolation_mode)?;
    let mut args = vec![String::from("models")];
    if force_refresh {
        args.push(String::from("--refresh"));
    }
    run_cli_command(
        command,
        &args,
        &execution_context,
        "OpenCode model listing",
        "opencode",
        command_source,
        resolved_binary_path,
        &[],
        None,
        None,
        None,
        false,
        None,
    )
    .await
}

fn is_opencode_invalid_config_error(error: &str) -> bool {
    let normalized = error.to_lowercase();
    normalized.contains("config file")
        && (normalized.contains("not valid json") || normalized.contains("invalid json"))
}

pub async fn generate_attack_report_via_cli(
    reviewer_cli: &str,
    requirement: &str,
    code_a: &str,
    worktree_path: &str,
    runtime_config: Option<&RuntimeConfigInput>,
    phase12_run_context: Option<&Phase12CliRunContext>,
) -> Result<(Vec<AttackReportItem>, String), String> {
    let prompt = format!(
        "{AGENT_B_ATTACK_PROMPT}\n\nRequirement:\n{requirement}\n\nCode under test (Agent A):\n{code_a}\n"
    );
    let phase12_agent_context = phase12_run_context.map(|context| Phase12CliAgentContext {
        request_id: context.request_id.clone(),
        phase: context.phase,
        agent_id: "phase3_agent_b".to_string(),
        agent_label: "Agent B · Reviewer".to_string(),
        agent_cli: reviewer_cli.to_string(),
        emitter: Arc::clone(&context.emitter),
        legacy_phase12_emitter: context.legacy_phase12_emitter.clone(),
    });
    let raw = run_agent_cli(
        reviewer_cli,
        Some("phase3_agent_b"),
        &prompt,
        worktree_path,
        Some(worktree_path),
        "Agent B CLI attack analysis",
        runtime_config,
        CliExecutionIsolationMode::SharedWorktree,
        phase12_agent_context.as_ref(),
    )
    .await?;
    if raw.is_empty() {
        return Err("Agent B CLI returned empty output".to_string());
    }

    let parsed = parse_json_payload::<AttackReportEnvelope>(&raw)
        .map_err(|err| format!("Agent B CLI returned invalid attack report JSON: {err}"))?;
    if parsed.attack_report.is_empty() {
        return Err("Agent B CLI returned an empty attack_report".to_string());
    }

    Ok((parsed.attack_report, raw))
}

pub async fn run_agent_cli(
    agent_cli: &str,
    agent_model_scope: Option<&str>,
    prompt: &str,
    workdir: &str,
    capture_base_dir: Option<&str>,
    label: &str,
    runtime_config: Option<&RuntimeConfigInput>,
    isolation_mode: CliExecutionIsolationMode,
    phase12_agent_context: Option<&Phase12CliAgentContext>,
) -> Result<String, String> {
    let mut capture_path: Option<PathBuf> = None;
    let mut extra_environment: Vec<(String, String)> = Vec::new();
    let mut startup_info_chunk: Option<String> = None;
    let mut fallback_args_on_error: Option<Vec<String>> = None;
    let execution_context =
        prepare_cli_execution_context(workdir, capture_base_dir, isolation_mode)?;
    let command_resolution = resolve_cli_command(agent_cli, runtime_config)?;
    let command = command_resolution.command.clone();
    let command_source = command_resolution.source.clone();
    let resolved_binary_path = resolve_binary_path(&command);
    let model_resolution = resolve_agent_cli_model(runtime_config, agent_model_scope, agent_cli);
    let (command, args): (String, Vec<String>) = match agent_cli {
        "claude" => {
            let mut args = Vec::new();
            if let Some(model) = model_resolution.model.as_ref() {
                args.push("--model".to_string());
                args.push(model.clone());
            }
            args.push("-p".to_string());
            args.push(prompt.to_string());
            (command, args)
        }
        "codex" => {
            if isolation_mode == CliExecutionIsolationMode::StrictPhase12 {
                let readiness = determine_codex_runtime_readiness();
                if !readiness.runtime_ready {
                    let path_hint = resolved_binary_path
                        .as_deref()
                        .map(|path| format!(", path='{path}'"))
                        .unwrap_or_default();
                    let reason = readiness.readiness_reason.unwrap_or_else(|| {
                        "Codex auth missing in isolated runtime. Run `codex login` or choose another CLI."
                            .to_string()
                    });
                    return Err(format!(
                        "{label} selected CLI '{agent_cli}' resolved to command '{command}' ({command_source}{path_hint}) is not ready for strict phase1/2 isolation: {reason}"
                    ));
                }
                if let Some(auth_path) = readiness.host_auth_path.as_ref() {
                    let isolated_codex_home =
                        bridge_codex_auth_file_for_strict_phase12(&execution_context, auth_path)?;
                    extra_environment.push(("CODEX_HOME".to_string(), isolated_codex_home));
                }
            }
            let output_path = build_cli_capture_path(
                execution_context.capture_base_dir.as_deref(),
                "codex-output",
            )?;
            capture_path = Some(output_path.clone());
            (command, {
                let mut args = vec![
                    "exec".to_string(),
                    "--skip-git-repo-check".to_string(),
                    "--json".to_string(),
                    "-c".to_string(),
                    "model_reasoning_effort=\"high\"".to_string(),
                    "--color".to_string(),
                    "never".to_string(),
                ];
                if let Some(model) = model_resolution.model.as_ref() {
                    args.push("--model".to_string());
                    args.push(model.clone());
                }
                args.push("-o".to_string());
                args.push(output_path.to_string_lossy().to_string());
                args.push(prompt.to_string());
                args
            })
        }
        "gemini" => {
            if isolation_mode == CliExecutionIsolationMode::StrictPhase12 {
                let readiness = determine_gemini_runtime_readiness();
                if !readiness.runtime_ready {
                    let path_hint = resolved_binary_path
                        .as_deref()
                        .map(|path| format!(", path='{path}'"))
                        .unwrap_or_default();
                    let reason = readiness.readiness_reason.unwrap_or_else(|| {
                        "Gemini auth missing in strict phase1/2 isolation. Set GEMINI_API_KEY or configure OAuth."
                            .to_string()
                    });
                    return Err(format!(
                        "{label} selected CLI '{agent_cli}' resolved to command '{command}' ({command_source}{path_hint}) is not ready for strict phase1/2 isolation: {reason}"
                    ));
                }
                if let Some(reason) = readiness.readiness_reason.as_ref() {
                    println!("Gemini strict-phase12 auth note: {reason}");
                }
                if readiness.readiness_source == "gemini_oauth_cache" {
                    startup_info_chunk = Some(
                        "[info] Using cached Gemini credentials (strict isolation). Startup may be slower."
                            .to_string(),
                    );
                }
                if let Err(err) = bridge_gemini_config_for_strict_phase12(&execution_context) {
                    println!("Warning: failed to bridge gemini config: {err}");
                }
            }
            let mut args = vec![
                "-p".to_string(),
                prompt.to_string(),
                "--output-format".to_string(),
                "stream-json".to_string(),
            ];
            if let Some(model) = model_resolution.model.as_ref() {
                args.push("--model".to_string());
                args.push(model.clone());
            }
            let mut text_fallback_args = vec!["-p".to_string(), prompt.to_string()];
            if let Some(model) = model_resolution.model.as_ref() {
                text_fallback_args.push("--model".to_string());
                text_fallback_args.push(model.clone());
            }
            text_fallback_args.push("-o".to_string());
            text_fallback_args.push("text".to_string());
            fallback_args_on_error = Some(text_fallback_args);
            (command, args)
        }
        "opencode" => {
            if isolation_mode == CliExecutionIsolationMode::SharedWorktree {
                let state_home = ensure_opencode_shared_state_home(&execution_context.workdir)?;
                extra_environment.push(("XDG_STATE_HOME".to_string(), state_home));
            } else if isolation_mode == CliExecutionIsolationMode::StrictPhase12 {
                if let Err(err) = bridge_opencode_config_for_strict_phase12(&execution_context) {
                    println!("Warning: failed to bridge opencode config: {err}");
                }
                let strict_state_home = ensure_opencode_strict_state_home(
                    phase12_agent_context.map(|context| context.agent_id.as_str()),
                )?;
                extra_environment.push(("XDG_STATE_HOME".to_string(), strict_state_home));
                startup_info_chunk =
                    Some("[info] Using cached OpenCode state (strict isolation).".to_string());
            }
            let mut args = vec![
                "run".to_string(),
                "--format".to_string(),
                "json".to_string(),
            ];
            if let Some(model) = model_resolution.model.as_ref() {
                // Pass the model as-is — OpenCode lists and accepts the full provider/model
                // format (e.g. "ollama/deepseek-coder:6.7b") from its own model inventory.
                args.push("--model".to_string());
                args.push(model.clone());
            }
            args.push(prompt.to_string());
            (command, args)
        }
        unsupported => {
            return Err(format!(
                "Unsupported CLI '{unsupported}'. Use claude|codex|gemini|opencode."
            ));
        }
    };

    let output = match run_cli_command(
        &command,
        &args,
        &execution_context,
        label,
        agent_cli,
        &command_source,
        resolved_binary_path.as_deref(),
        &extra_environment,
        phase12_agent_context,
        model_resolution.model.as_deref(),
        model_resolution.source.as_deref(),
        true,
        startup_info_chunk.as_deref(),
    )
    .await
    {
        Ok(output) => output,
        Err(initial_error)
            if agent_cli == "gemini"
                && fallback_args_on_error.is_some()
                && is_gemini_stream_json_not_supported_error(initial_error.as_str()) =>
        {
            let fallback_args = fallback_args_on_error.take().unwrap_or_default();
            run_cli_command(
                &command,
                &fallback_args,
                &execution_context,
                label,
                agent_cli,
                &command_source,
                resolved_binary_path.as_deref(),
                &extra_environment,
                phase12_agent_context,
                model_resolution.model.as_deref(),
                model_resolution.source.as_deref(),
                true,
                startup_info_chunk.as_deref(),
            )
            .await?
        }
        Err(initial_error) => return Err(initial_error),
    };

    let default_raw_from_output = || {
        if output.stdout.trim().is_empty() {
            output.stderr.trim().to_string()
        } else {
            output.stdout.trim().to_string()
        }
    };

    let raw = if let Some(path) = capture_path {
        match fs::read_to_string(path) {
            Ok(content) if !content.trim().is_empty() => content.trim().to_string(),
            _ => default_raw_from_output(),
        }
    } else if agent_cli == "opencode" {
        normalize_opencode_json_stream(&output.stdout).unwrap_or_else(default_raw_from_output)
    } else {
        default_raw_from_output()
    };

    if let Some(context) = phase12_agent_context {
        if output.streamed_chunk_count == 0 && !raw.trim().is_empty() {
            let fallback = truncate(raw.trim(), CLI_TIMELINE_FALLBACK_OUTPUT_MAX_CHARS);
            let chunk = format!("[info] no live stream; showing final output\n{fallback}\n");
            emit_cli_command_event(
                context,
                CliCommandLogKind::CommandChunk,
                output.command_id.clone(),
                Some(CliOutputStreamKind::Stdout),
                Some(chunk),
                None,
                None,
                None,
                None,
                None,
                None,
            );
        }
    }

    if raw.trim().is_empty() {
        let path_hint = resolved_binary_path
            .as_deref()
            .map(|path| format!(", path='{path}'"))
            .unwrap_or_default();
        if output.timed_out {
            return Err(format!(
                "{label} selected CLI '{agent_cli}' resolved to command '{command}' ({command_source}{path_hint}) timed out after {} seconds",
                cli_timeout_secs()
            ));
        }
        return Err(format!(
            "{label} selected CLI '{agent_cli}' resolved to command '{command}' ({command_source}{path_hint}) returned empty output"
        ));
    }

    Ok(raw)
}

fn is_gemini_stream_json_not_supported_error(error: &str) -> bool {
    let normalized = error.to_lowercase();
    (normalized.contains("output-format")
        && (normalized.contains("unknown")
            || normalized.contains("invalid")
            || normalized.contains("unrecognized")
            || normalized.contains("unexpected")))
        || (normalized.contains("stream-json")
            && (normalized.contains("invalid") || normalized.contains("unknown")))
}

fn prepare_cli_execution_context(
    workdir: &str,
    capture_base_dir: Option<&str>,
    isolation_mode: CliExecutionIsolationMode,
) -> Result<CliExecutionContext, String> {
    match isolation_mode {
        CliExecutionIsolationMode::SharedWorktree => Ok(CliExecutionContext {
            workdir: PathBuf::from(workdir),
            capture_base_dir: capture_base_dir.map(PathBuf::from),
            child_environment: CliChildEnvironment::Inherit,
            _cleanup_guard: None,
        }),
        CliExecutionIsolationMode::StrictPhase12 => {
            let root = env::temp_dir().join(format!(
                "friction-phase12-isolation-{}",
                Uuid::new_v4().simple()
            ));
            let cwd = root.join("cwd");
            let home = root.join("home");
            let xdg_root = root.join("xdg");
            let xdg_config = xdg_root.join("config");
            let xdg_data = xdg_root.join("data");
            let xdg_cache = xdg_root.join("cache");
            let xdg_state = xdg_root.join("state");

            for dir in [
                &root,
                &cwd,
                &home,
                &xdg_config,
                &xdg_data,
                &xdg_cache,
                &xdg_state,
            ] {
                fs::create_dir_all(dir).map_err(|err| {
                    format!(
                        "failed to create strict phase1/2 isolation directory {:?}: {err}",
                        dir
                    )
                })?;
            }

            let overrides = vec![
                ("HOME".to_string(), home.to_string_lossy().to_string()),
                (
                    "USERPROFILE".to_string(),
                    home.to_string_lossy().to_string(),
                ),
                (
                    "XDG_CONFIG_HOME".to_string(),
                    xdg_config.to_string_lossy().to_string(),
                ),
                (
                    "XDG_DATA_HOME".to_string(),
                    xdg_data.to_string_lossy().to_string(),
                ),
                (
                    "XDG_CACHE_HOME".to_string(),
                    xdg_cache.to_string_lossy().to_string(),
                ),
                (
                    "XDG_STATE_HOME".to_string(),
                    xdg_state.to_string_lossy().to_string(),
                ),
            ];

            Ok(CliExecutionContext {
                workdir: cwd,
                capture_base_dir: Some(root.clone()),
                child_environment: CliChildEnvironment::Strict {
                    preserved: collect_strict_phase12_environment(),
                    overrides,
                },
                _cleanup_guard: Some(StrictIsolationCleanup { root }),
            })
        }
    }
}

fn collect_strict_phase12_environment() -> Vec<(String, String)> {
    const PRESERVED_KEYS: &[&str] = &[
        "PATH",
        "LANG",
        "LC_ALL",
        "TERM",
        "TMPDIR",
        "TMP",
        "TEMP",
        "XDG_STATE_HOME",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "REQUESTS_CA_BUNDLE",
        "CURL_CA_BUNDLE",
        "NODE_EXTRA_CA_CERTS",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "GEMINI_USE_VERTEXAI",
        "VERTEXAI",
        "GOOGLE_GENAI_USE_GCA",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_CLOUD_PROJECT",
        "GCLOUD_PROJECT",
        "VERTEX_PROJECT",
        "GOOGLE_CLOUD_LOCATION",
        "CLOUD_ML_REGION",
        "GOOGLE_VERTEX_ACCESS_TOKEN",
        "GOOGLE_OAUTH_ACCESS_TOKEN",
        "GOOGLE_ACCESS_TOKEN",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
    ];

    PRESERVED_KEYS
        .iter()
        .filter_map(|key| {
            env::var(key)
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(|value| ((*key).to_string(), value))
        })
        .collect()
}

fn ensure_opencode_shared_state_home(workdir: &Path) -> Result<String, String> {
    let state_home = workdir.join(".friction").join("opencode-state");
    fs::create_dir_all(&state_home).map_err(|err| {
        format!(
            "failed to create opencode state directory {:?}: {err}",
            state_home
        )
    })?;
    Ok(state_home.to_string_lossy().to_string())
}

fn sanitize_state_component(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if sanitized.is_empty() {
        "default".to_string()
    } else {
        sanitized
    }
}

fn ensure_opencode_strict_state_home(agent_id: Option<&str>) -> Result<String, String> {
    let root = env::var("FRICTION_OPENCODE_STRICT_STATE_HOME")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::cache_dir()
                .unwrap_or_else(|| env::temp_dir().join("friction-cache"))
                .join("friction")
                .join("opencode-state")
        });
    let bucket = agent_id
        .map(sanitize_state_component)
        .unwrap_or_else(|| "default".to_string());
    let state_home = root.join(bucket);
    fs::create_dir_all(&state_home).map_err(|err| {
        format!(
            "failed to create strict opencode state directory {:?}: {err}",
            state_home
        )
    })?;
    Ok(state_home.to_string_lossy().to_string())
}

fn determine_codex_runtime_readiness() -> CodexRuntimeReadiness {
    if env::var("OPENAI_API_KEY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .is_some()
    {
        return CodexRuntimeReadiness {
            runtime_ready: true,
            readiness_reason: None,
            readiness_source: "openai_api_key".to_string(),
            host_auth_path: None,
        };
    }

    let expected_auth_path = resolve_codex_auth_expected_path();
    if let Some(auth_path) = expected_auth_path.as_ref() {
        if auth_path.is_file() {
            return CodexRuntimeReadiness {
                runtime_ready: true,
                readiness_reason: None,
                readiness_source: "codex_auth_file".to_string(),
                host_auth_path: Some(auth_path.clone()),
            };
        }
    }

    let location_hint = expected_auth_path
        .map(|path| format!("Expected auth file: {}.", path.to_string_lossy()))
        .unwrap_or_else(|| {
            "Expected auth file under CODEX_HOME/auth.json or HOME/.codex/auth.json.".to_string()
        });

    CodexRuntimeReadiness {
        runtime_ready: false,
        readiness_reason: Some(format!(
            "Codex auth missing in isolated runtime. Run `codex login` or choose another CLI. {location_hint}"
        )),
        readiness_source: "none".to_string(),
        host_auth_path: None,
    }
}

fn resolve_codex_auth_expected_path() -> Option<PathBuf> {
    if let Some(codex_home) = env::var("CODEX_HOME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return Some(PathBuf::from(codex_home).join("auth.json"));
    }

    env::var("HOME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(|home| PathBuf::from(home).join(".codex").join("auth.json"))
}

fn determine_gemini_runtime_readiness() -> GeminiRuntimeReadiness {
    if let Some((_, source)) = env_non_empty_with_source(&[
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
    ]) {
        return GeminiRuntimeReadiness {
            runtime_ready: true,
            readiness_reason: None,
            readiness_source: source,
        };
    }

    if let Some(source) = env_truthy_with_source(&[
        "GOOGLE_GENAI_USE_VERTEXAI",
        "GEMINI_USE_VERTEXAI",
        "VERTEXAI",
    ]) {
        return GeminiRuntimeReadiness {
            runtime_ready: true,
            readiness_reason: None,
            readiness_source: source,
        };
    }

    let Some(gemini_dir) = host_gemini_config_dir() else {
        return GeminiRuntimeReadiness {
            runtime_ready: false,
            readiness_reason: Some(
                "Gemini auth missing in strict phase1/2 isolation. Set GEMINI_API_KEY or configure OAuth in ~/.gemini."
                    .to_string(),
            ),
            readiness_source: "none".to_string(),
        };
    };
    let has_settings = gemini_dir.join("settings.json").is_file();
    let has_oauth_cache = gemini_dir.join("oauth_creds.json").is_file()
        || gemini_dir.join("google_accounts.json").is_file();
    if has_settings && has_oauth_cache {
        return GeminiRuntimeReadiness {
            runtime_ready: true,
            readiness_reason: Some(
                "Using cached Gemini OAuth credentials in strict isolation; startup can be slower than GEMINI_API_KEY."
                    .to_string(),
            ),
            readiness_source: "gemini_oauth_cache".to_string(),
        };
    }

    GeminiRuntimeReadiness {
        runtime_ready: false,
        readiness_reason: Some(
            "Gemini auth missing in strict phase1/2 isolation. Set GEMINI_API_KEY or configure OAuth in ~/.gemini."
                .to_string(),
        ),
        readiness_source: "none".to_string(),
    }
}

fn bridge_codex_auth_file_for_strict_phase12(
    execution_context: &CliExecutionContext,
    host_auth_path: &Path,
) -> Result<String, String> {
    let bridge_base_dir = execution_context
        .capture_base_dir
        .clone()
        .unwrap_or_else(|| execution_context.workdir.clone());
    let codex_home = bridge_base_dir.join("codex-home");
    fs::create_dir_all(&codex_home).map_err(|err| {
        format!(
            "failed to create strict phase1/2 codex home {:?}: {err}",
            codex_home
        )
    })?;

    let destination = codex_home.join("auth.json");
    fs::copy(host_auth_path, &destination).map_err(|err| {
        format!(
            "failed to bridge codex auth file from {:?} to {:?}: {err}",
            host_auth_path, destination
        )
    })?;

    Ok(codex_home.to_string_lossy().to_string())
}

fn strict_phase12_override_path(
    execution_context: &CliExecutionContext,
    key: &str,
) -> Option<PathBuf> {
    let CliChildEnvironment::Strict { overrides, .. } = &execution_context.child_environment else {
        return None;
    };
    overrides.iter().find_map(|(k, v)| {
        if k == key && !v.trim().is_empty() {
            Some(PathBuf::from(v))
        } else {
            None
        }
    })
}

fn host_gemini_config_dir() -> Option<PathBuf> {
    if let Some(value) = env::var("GEMINI_HOME")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        return Some(PathBuf::from(value));
    }
    dirs::home_dir().map(|home| home.join(".gemini"))
}

fn gemini_bridge_cache_root() -> PathBuf {
    env::temp_dir().join("friction-gemini-bridge-cache")
}

fn file_modified_epoch_secs(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|timestamp| timestamp.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
}

fn sync_gemini_bridge_cache_file(source: &Path, cache: &Path) -> Result<(), String> {
    let source_meta = fs::metadata(source)
        .map_err(|err| format!("failed to read Gemini source metadata {:?}: {err}", source))?;
    let source_len = source_meta.len();
    let source_mtime = file_modified_epoch_secs(source).unwrap_or(0);

    let mut cache_is_current = false;
    if let Ok(cache_meta) = fs::metadata(cache) {
        let cache_len = cache_meta.len();
        let cache_mtime = file_modified_epoch_secs(cache).unwrap_or(0);
        if cache_len == source_len && cache_mtime >= source_mtime {
            let source_bytes = fs::read(source)
                .map_err(|err| format!("failed to read Gemini source file {:?}: {err}", source))?;
            let cache_bytes = fs::read(cache)
                .map_err(|err| format!("failed to read Gemini cache file {:?}: {err}", cache))?;
            cache_is_current = source_bytes == cache_bytes;
        }
    }

    if cache_is_current {
        return Ok(());
    }

    if let Some(parent) = cache.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "failed to create Gemini bridge cache directory {:?}: {err}",
                parent
            )
        })?;
    }

    fs::copy(source, cache).map_err(|err| {
        format!(
            "failed to refresh Gemini bridge cache file from {:?} to {:?}: {err}",
            source, cache
        )
    })?;
    Ok(())
}

fn hard_link_or_symlink_or_copy(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        let _ = fs::remove_file(destination);
    }

    if fs::hard_link(source, destination).is_ok() {
        return Ok(());
    }

    #[cfg(unix)]
    {
        if std::os::unix::fs::symlink(source, destination).is_ok() {
            return Ok(());
        }
    }

    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_file(source, destination).is_ok() {
            return Ok(());
        }
    }

    fs::copy(source, destination).map_err(|err| {
        format!(
            "failed to copy Gemini config file from {:?} to {:?}: {err}",
            source, destination
        )
    })?;
    Ok(())
}

fn gemini_bridge_prefers_link(file_name: &str) -> bool {
    matches!(file_name, "oauth_creds.json" | "google_accounts.json")
}

fn bridge_gemini_config_for_strict_phase12(
    execution_context: &CliExecutionContext,
) -> Result<(), String> {
    let Some(host_gemini_dir) = host_gemini_config_dir() else {
        return Ok(());
    };
    if !host_gemini_dir.is_dir() {
        return Ok(());
    }

    let Some(isolated_home) = strict_phase12_override_path(execution_context, "HOME") else {
        return Ok(());
    };
    let isolated_gemini_dir = isolated_home.join(".gemini");
    fs::create_dir_all(&isolated_gemini_dir).map_err(|err| {
        format!(
            "failed to create strict phase1/2 Gemini config directory {:?}: {err}",
            isolated_gemini_dir
        )
    })?;

    let files_to_bridge = [
        "settings.json",
        "oauth_creds.json",
        "google_accounts.json",
        "state.json",
        "projects.json",
        "trustedFolders.json",
    ];

    for file_name in files_to_bridge {
        let source = host_gemini_dir.join(file_name);
        if !source.is_file() {
            continue;
        }
        let destination = isolated_gemini_dir.join(file_name);
        if gemini_bridge_prefers_link(file_name) {
            let cache_path = gemini_bridge_cache_root().join(file_name);
            sync_gemini_bridge_cache_file(&source, &cache_path)?;
            hard_link_or_symlink_or_copy(&cache_path, &destination).map_err(|err| {
                format!(
                    "failed to link Gemini config file from {:?} to {:?}: {err}",
                    cache_path, destination
                )
            })?;
            continue;
        }
        fs::copy(&source, &destination).map_err(|err| {
            format!(
                "failed to bridge Gemini config file from {:?} to {:?}: {err}",
                source, destination
            )
        })?;
    }

    Ok(())
}

fn bridge_opencode_config_for_strict_phase12(
    execution_context: &CliExecutionContext,
) -> Result<(), String> {
    let mut isolated_home: Option<PathBuf> = None;
    let mut isolated_xdg_config: Option<PathBuf> = None;

    if let CliChildEnvironment::Strict { overrides, .. } = &execution_context.child_environment {
        for (k, v) in overrides {
            if k == "HOME" {
                isolated_home = Some(PathBuf::from(v));
            } else if k == "XDG_CONFIG_HOME" {
                isolated_xdg_config = Some(PathBuf::from(v));
            }
        }
    }

    let symlink_dir = |src: &PathBuf, dst: &PathBuf| {
        #[cfg(unix)]
        let _ = std::os::unix::fs::symlink(src, dst);
        #[cfg(windows)]
        let _ = std::os::windows::fs::symlink_dir(src, dst);
    };

    let host_home = dirs::home_dir();

    if let Some(home) = &host_home {
        let opencode_dir = home.join(".opencode");
        if opencode_dir.is_dir() {
            if let Some(iso_home) = &isolated_home {
                symlink_dir(&opencode_dir, &iso_home.join(".opencode"));
            }
        }
    }

    // Try multiple possible config locations
    let mut config_candidates = Vec::new();

    // 1. Standard OS config dir (e.g. ~/Library/Application Support on macOS, ~/.config on Linux)
    if let Some(config) = dirs::config_dir() {
        config_candidates.push(config.join("opencode"));
    }

    // 2. Explicitly try ~/.config/opencode since many CLI tools use XDG on macOS despite the OS standard
    if let Some(home) = &host_home {
        config_candidates.push(home.join(".config").join("opencode"));
    }

    for opencode_config in config_candidates {
        if opencode_config.is_dir() {
            // 1. Symlink to XDG_CONFIG_HOME/opencode (this is what opencode will check first due to env var override)
            if let Some(iso_xdg) = &isolated_xdg_config {
                let dest = iso_xdg.join("opencode");
                if !dest.exists() {
                    symlink_dir(&opencode_config, &dest);
                }
            }

            // 2. Symlink to the isolated HOME's equivalent OS config path if possible
            if let (Some(iso_home), Some(h_home)) = (&isolated_home, &host_home) {
                if let Ok(rel) = opencode_config
                    .parent()
                    .unwrap_or(&opencode_config)
                    .strip_prefix(h_home)
                {
                    let dest_config_dir = iso_home.join(rel);
                    let _ = std::fs::create_dir_all(&dest_config_dir);
                    let dest = dest_config_dir.join("opencode");
                    if !dest.exists() {
                        symlink_dir(&opencode_config, &dest);
                    }
                }
            }
        }
    }

    Ok(())
}

fn normalize_opencode_json_stream(stdout: &str) -> Option<String> {
    let mut chunks: Vec<String> = Vec::new();
    let mut first_error: Option<String> = None;

    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let payload: Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(_) => continue,
        };

        let event_type = payload.get("type").and_then(Value::as_str);

        // Capture error events — return these as a real error message
        if event_type == Some("error") {
            if first_error.is_none() {
                let msg = payload
                    .get("error")
                    .and_then(|e| e.get("data"))
                    .and_then(|d| d.get("message"))
                    .and_then(Value::as_str)
                    .or_else(|| {
                        payload
                            .get("error")
                            .and_then(|e| e.get("message"))
                            .and_then(Value::as_str)
                    })
                    .unwrap_or("Unknown error from opencode");
                first_error = Some(format!("OpenCode error: {msg}"));
            }
            continue;
        }

        // Primary: opencode `text` events
        if event_type == Some("text") {
            let text_value = payload.get("part").and_then(|part| part.get("text"));
            let text = match text_value {
                Some(Value::String(value)) => {
                    let t = value.trim();
                    if t.is_empty() {
                        None
                    } else {
                        Some(t.to_string())
                    }
                }
                Some(Value::Null) | None => None,
                Some(other) => Some(other.to_string()),
            };
            if let Some(text) = text {
                chunks.push(text);
                continue;
            }
        }

        // Fallback: some models (e.g. ollama via opencode) emit assistant message events
        if event_type == Some("message") || event_type == Some("assistant") {
            // Try payload.content[*].text
            if let Some(content_arr) = payload.get("content").and_then(Value::as_array) {
                for item in content_arr {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        let t = text.trim();
                        if !t.is_empty() {
                            chunks.push(t.to_string());
                        }
                    }
                }
            }
            // Try payload.message.content
            if let Some(text) = payload
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(Value::as_str)
            {
                let t = text.trim();
                if !t.is_empty() {
                    chunks.push(t.to_string());
                }
            }
        }

        // Fallback: content_block_delta events (Anthropic stream format sometimes proxied)
        if event_type == Some("content_block_delta") {
            if let Some(text) = payload
                .get("delta")
                .and_then(|d| d.get("text"))
                .and_then(Value::as_str)
            {
                let t = text.trim();
                if !t.is_empty() {
                    chunks.push(t.to_string());
                }
            }
        }
    }

    if chunks.is_empty() {
        // If we got an error event but no content, surface the error as the raw string.
        // The caller will then produce a more useful error message than "empty payload".
        if let Some(err) = first_error {
            return Some(err);
        }
        // Last resort: try to find any JSON object in the raw stdout that could be the response
        if let Some(extracted) = extract_json(stdout) {
            if extracted.len() > 10 {
                return Some(extracted);
            }
        }
        None
    } else {
        let combined = chunks.concat();
        if let Some(best_json) = extract_json(&combined) {
            return Some(best_json);
        }
        Some(combined)
    }
}

fn parse_opencode_models_output(stdout: &str, stderr: &str) -> Vec<String> {
    let mut models: Vec<String> = Vec::new();
    let mut push_unique = |model: String| {
        if !models.iter().any(|item| item == &model) {
            models.push(model);
        }
    };

    for line in stdout.lines().chain(stderr.lines()) {
        let candidates = parse_model_candidates_from_line(line);
        for candidate in candidates {
            push_unique(candidate);
        }
    }

    models
}

fn parse_model_candidates_from_line(line: &str) -> Vec<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    if trimmed.contains('|') {
        let mut from_cells = Vec::new();
        for cell in trimmed.split('|') {
            from_cells.extend(parse_model_candidates_from_line(cell));
        }
        return from_cells;
    }

    let stripped = trimmed
        .trim_start_matches('-')
        .trim_start_matches('*')
        .trim_start_matches('•')
        .trim();

    if stripped.is_empty() {
        return Vec::new();
    }

    if stripped.starts_with("Commands:")
        || stripped.starts_with("Positionals:")
        || stripped.starts_with("Options:")
    {
        return Vec::new();
    }

    if !stripped.contains('/') || stripped.chars().any(char::is_whitespace) {
        return Vec::new();
    }

    vec![stripped.to_string()]
}

fn resolve_cli_command(
    agent_cli: &str,
    runtime_config: Option<&RuntimeConfigInput>,
) -> Result<CliCommandResolution, String> {
    match agent_cli {
        "claude" => Ok(resolve_claude_cli_command_resolution(runtime_config)),
        "codex" => Ok(resolve_codex_cli_command_resolution(runtime_config)),
        "gemini" => Ok(resolve_gemini_cli_command_resolution(runtime_config)),
        "opencode" => Ok(resolve_opencode_cli_command_resolution(runtime_config)),
        unsupported => Err(format!(
            "Unsupported CLI '{unsupported}'. Use claude|codex|gemini|opencode."
        )),
    }
}

fn runtime_cli_override(
    runtime_config: Option<&RuntimeConfigInput>,
    alias: &str,
) -> Option<String> {
    runtime_config
        .and_then(|config| config.cli_commands.as_ref())
        .and_then(|commands| commands.get(alias))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn runtime_cli_model_override(
    runtime_config: Option<&RuntimeConfigInput>,
    alias: &str,
) -> Option<String> {
    runtime_config
        .and_then(|config| config.cli_models.as_ref())
        .and_then(|models| models.get(alias))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn runtime_agent_cli_model_override(
    runtime_config: Option<&RuntimeConfigInput>,
    agent_scope: Option<&str>,
) -> Option<String> {
    agent_scope.and_then(|scope| {
        runtime_config
            .and_then(|config| config.agent_cli_models.as_ref())
            .and_then(|models| models.get(scope))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn resolve_agent_cli_model(
    runtime_config: Option<&RuntimeConfigInput>,
    agent_scope: Option<&str>,
    alias: &str,
) -> AgentCliModelResolution {
    if let Some(scope) = agent_scope {
        if let Some(model) = runtime_agent_cli_model_override(runtime_config, Some(scope)) {
            return AgentCliModelResolution {
                model: Some(model),
                source: Some(format!("runtime:agent_cli_models.{scope}")),
            };
        }
    }

    if let Some(model) = runtime_cli_model_override(runtime_config, alias) {
        return AgentCliModelResolution {
            model: Some(model),
            source: Some(format!("runtime:cli_models.{alias}")),
        };
    }

    AgentCliModelResolution {
        model: None,
        source: Some(format!("default:{alias}")),
    }
}

fn resolve_with_fallback(
    runtime_override: Option<String>,
    runtime_source: &str,
    default_command: &str,
) -> CliCommandResolution {
    if let Some(command) = runtime_override {
        return CliCommandResolution {
            command,
            source: runtime_source.to_string(),
        };
    }

    CliCommandResolution {
        command: default_command.to_string(),
        source: format!("default:{default_command}"),
    }
}

fn resolve_claude_cli_command_resolution(
    runtime_config: Option<&RuntimeConfigInput>,
) -> CliCommandResolution {
    resolve_with_fallback(
        runtime_cli_override(runtime_config, "claude"),
        "runtime:cli_commands.claude",
        "claude",
    )
}

fn resolve_codex_cli_command_resolution(
    runtime_config: Option<&RuntimeConfigInput>,
) -> CliCommandResolution {
    resolve_with_fallback(
        runtime_cli_override(runtime_config, "codex"),
        "runtime:cli_commands.codex",
        "codex",
    )
}

fn resolve_gemini_cli_command_resolution(
    runtime_config: Option<&RuntimeConfigInput>,
) -> CliCommandResolution {
    resolve_with_fallback(
        runtime_cli_override(runtime_config, "gemini"),
        "runtime:cli_commands.gemini",
        "gemini",
    )
}

fn resolve_opencode_cli_command_resolution(
    runtime_config: Option<&RuntimeConfigInput>,
) -> CliCommandResolution {
    resolve_with_fallback(
        runtime_cli_override(runtime_config, "opencode"),
        "runtime:cli_commands.opencode",
        "opencode",
    )
}

fn resolve_binary_path(command: &str) -> Option<String> {
    let command_path = Path::new(command);
    if command_path.is_absolute() || command.contains(std::path::MAIN_SEPARATOR) {
        if command_path.exists() {
            return Some(command_path.to_string_lossy().to_string());
        }
        return None;
    }

    let path = env::var_os("PATH")?;
    for dir in env::split_paths(&path) {
        let candidate = dir.join(command);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }

    None
}

fn infer_cli_family(command: &str) -> String {
    let command_lower = command.to_lowercase();
    let basename = Path::new(command)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(command)
        .to_lowercase();

    if basename.contains("claude") || command_lower.contains("claude") {
        "claude".to_string()
    } else if basename.contains("codex") || command_lower.contains("codex") {
        "codex".to_string()
    } else if basename.contains("gemini") || command_lower.contains("gemini") {
        "gemini".to_string()
    } else if basename.contains("opencode") || command_lower.contains("opencode") {
        "opencode".to_string()
    } else {
        "unknown".to_string()
    }
}

fn build_cli_capture_path(
    capture_base_dir: Option<&Path>,
    prefix: &str,
) -> Result<PathBuf, String> {
    let parent = capture_base_dir
        .map(|dir| dir.join(".friction").join("generated"))
        .unwrap_or_else(|| env::temp_dir().join("friction-cli"));
    fs::create_dir_all(&parent)
        .map_err(|err| format!("failed to create CLI output directory {:?}: {err}", parent))?;

    Ok(parent.join(format!("{prefix}-{}.txt", Uuid::new_v4().simple())))
}

fn runtime_agents(
    runtime_config: Option<&RuntimeConfigInput>,
) -> Result<(RuntimeAgent, RuntimeAgent), String> {
    let architect = build_agent_from_env(
        AgentRole::Architect,
        runtime_config.and_then(|config| config.architect.as_ref()),
        runtime_config.and_then(|config| config.ollama_host.as_deref()),
        "FRICTION_ARCHITECT_PROVIDER",
        "FRICTION_ARCHITECT_MODEL",
        "mock",
        "claude-sonnet-4-20250514",
    )?;

    let pragmatist = build_agent_from_env(
        AgentRole::Pragmatist,
        runtime_config.and_then(|config| config.pragmatist.as_ref()),
        runtime_config.and_then(|config| config.ollama_host.as_deref()),
        "FRICTION_PRAGMATIST_PROVIDER",
        "FRICTION_PRAGMATIST_MODEL",
        "mock",
        "gpt-4o",
    )?;

    Ok((architect, pragmatist))
}

#[allow(clippy::too_many_arguments)]
fn build_agent_from_env(
    role: AgentRole,
    runtime_override: Option<&RuntimeAgentInput>,
    ollama_host_override: Option<&str>,
    provider_key: &str,
    model_key: &str,
    default_provider: &str,
    default_model: &str,
) -> Result<RuntimeAgent, String> {
    let provider_value = runtime_override
        .map(|item| item.provider.clone())
        .unwrap_or_else(|| env::var(provider_key).unwrap_or_else(|_| default_provider.to_string()))
        .to_lowercase();

    let model = runtime_override
        .and_then(|item| item.model.as_ref().cloned())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| env::var(model_key).unwrap_or_else(|_| default_model.to_string()));
    let provider = match provider_value.as_str() {
        "mock" => ProviderKind::Mock,
        "anthropic" => {
            let key = env::var("ANTHROPIC_API_KEY")
                .map_err(|_| "ANTHROPIC_API_KEY is missing for anthropic provider".to_string())?;
            ProviderKind::Anthropic { api_key: key }
        }
        "openai" => {
            let key = env::var("OPENAI_API_KEY")
                .map_err(|_| "OPENAI_API_KEY is missing for openai provider".to_string())?;
            ProviderKind::OpenAi { api_key: key }
        }
        "ollama" => {
            let host = ollama_host_override
                .map(str::to_string)
                .or_else(|| env::var("OLLAMA_HOST").ok())
                .or_else(|| env::var("FRICTION_OLLAMA_HOST").ok())
                .unwrap_or_else(|| "http://localhost:11434".to_string());
            ProviderKind::Ollama { host }
        }
        unsupported => {
            return Err(format!(
                "Unsupported provider '{unsupported}' in {provider_key}. Use mock|anthropic|openai|ollama"
            ))
        }
    };

    Ok(RuntimeAgent {
        model,
        role,
        provider,
    })
}

fn cli_timeout_secs() -> u64 {
    env::var("FRICTION_PHASE3_CLI_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(240)
}

async fn read_cli_stream_chunks<R>(
    mut reader: R,
    stream_kind: CliOutputStreamKind,
    phase12_agent_context: Option<Phase12CliAgentContext>,
    command_id: Option<String>,
    streamed_chunk_counter: Option<Arc<AtomicUsize>>,
) -> Result<String, String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut output = String::new();
    let mut buffer = vec![0_u8; 4096];

    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read_len) => {
                let chunk = String::from_utf8_lossy(&buffer[..read_len]).to_string();
                output.push_str(&chunk);
                if let Some(counter) = streamed_chunk_counter.as_ref() {
                    counter.fetch_add(1, Ordering::Relaxed);
                }
                if let Some(context) = phase12_agent_context.as_ref() {
                    emit_cli_command_event(
                        context,
                        CliCommandLogKind::CommandChunk,
                        command_id.clone(),
                        Some(stream_kind),
                        Some(chunk),
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                    );
                }
            }
            Err(err) if err.kind() == ErrorKind::Interrupted => continue,
            Err(err) => {
                let stream_label = match stream_kind {
                    CliOutputStreamKind::Stdout => "stdout",
                    CliOutputStreamKind::Stderr => "stderr",
                };
                return Err(format!(
                    "failed to read process {stream_label} stream: {err}"
                ));
            }
        }
    }

    Ok(output)
}

async fn await_cli_stream_task(
    handle: tokio::task::JoinHandle<Result<String, String>>,
    stream_label: &str,
) -> Result<String, String> {
    handle
        .await
        .map_err(|err| format!("failed to join {stream_label} stream task: {err}"))?
}

async fn run_cli_command(
    command: &str,
    args: &[String],
    execution_context: &CliExecutionContext,
    label: &str,
    selected_cli: &str,
    command_source: &str,
    resolved_binary_path: Option<&str>,
    extra_environment: &[(String, String)],
    phase12_agent_context: Option<&Phase12CliAgentContext>,
    resolved_model: Option<&str>,
    resolved_model_source: Option<&str>,
    allow_timeout_output_recovery: bool,
    startup_info_chunk: Option<&str>,
) -> Result<CliExecutionResult, String> {
    let timeout = Duration::from_secs(cli_timeout_secs());
    let path_hint = resolved_binary_path
        .map(|path| format!(", path='{path}'"))
        .unwrap_or_default();
    let command_id = phase12_agent_context.map(|_| format!("cmd_{}", Uuid::new_v4().simple()));

    let mut cmd = TokioCommand::new(command);
    cmd.args(args)
        .current_dir(&execution_context.workdir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    match &execution_context.child_environment {
        CliChildEnvironment::Inherit => {}
        CliChildEnvironment::Strict {
            preserved,
            overrides,
        } => {
            cmd.env_clear();
            for (key, value) in preserved {
                cmd.env(key, value);
            }
            for (key, value) in overrides {
                cmd.env(key, value);
            }
        }
    }
    for (key, value) in extra_environment {
        cmd.env(key, value);
    }

    if let Some(context) = phase12_agent_context {
        emit_cli_command_event(
            context,
            CliCommandLogKind::CommandStarted,
            command_id.clone(),
            None,
            None,
            Some(command.to_string()),
            Some(command_source.to_string()),
            resolved_binary_path.map(str::to_string),
            resolved_model.map(str::to_string),
            resolved_model_source.map(str::to_string),
            None,
        );
        emit_cli_command_event(
            context,
            CliCommandLogKind::CommandChunk,
            command_id.clone(),
            Some(CliOutputStreamKind::Stdout),
            Some("[info] command started\n".to_string()),
            None,
            None,
            None,
            None,
            None,
            None,
        );
        if let Some(info_chunk) = startup_info_chunk
            .map(str::trim)
            .filter(|chunk| !chunk.is_empty())
        {
            emit_cli_command_event(
                context,
                CliCommandLogKind::CommandChunk,
                command_id.clone(),
                Some(CliOutputStreamKind::Stdout),
                Some(format!("{info_chunk}\n")),
                None,
                None,
                None,
                None,
                None,
                None,
            );
        }
    }

    let mut child = cmd.spawn().map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            format!(
                "{label} selected CLI '{selected_cli}' resolved to command '{command}' ({command_source}{path_hint}) but command was not found in PATH"
            )
        } else {
            format!(
                "failed to execute {label}: selected CLI '{selected_cli}' resolved to command '{command}' ({command_source}{path_hint}) with error: {err}"
            )
        }
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture stdout stream".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture stderr stream".to_string())?;

    let streamed_chunk_count = Arc::new(AtomicUsize::new(0));
    let stdout_task = tokio::spawn(read_cli_stream_chunks(
        stdout,
        CliOutputStreamKind::Stdout,
        phase12_agent_context.cloned(),
        command_id.clone(),
        Some(Arc::clone(&streamed_chunk_count)),
    ));
    let stderr_task = tokio::spawn(read_cli_stream_chunks(
        stderr,
        CliOutputStreamKind::Stderr,
        phase12_agent_context.cloned(),
        command_id.clone(),
        Some(Arc::clone(&streamed_chunk_count)),
    ));
    let heartbeat_stop = Arc::new(AtomicBool::new(false));
    let mut heartbeat_task = phase12_agent_context.cloned().map(|context| {
        let command_id = command_id.clone();
        let stop = Arc::clone(&heartbeat_stop);
        let streamed_chunk_count = Arc::clone(&streamed_chunk_count);
        tokio::spawn(async move {
            let mut elapsed_secs = 0_u64;
            loop {
                tokio::time::sleep(Duration::from_secs(CLI_TIMELINE_HEARTBEAT_SECS)).await;
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                // Heartbeat only before the first real stdout/stderr chunk.
                if streamed_chunk_count.load(Ordering::Relaxed) > 0 {
                    continue;
                }
                elapsed_secs = elapsed_secs.saturating_add(CLI_TIMELINE_HEARTBEAT_SECS);
                emit_cli_command_event(
                    &context,
                    CliCommandLogKind::CommandChunk,
                    command_id.clone(),
                    Some(CliOutputStreamKind::Stdout),
                    Some(format!(
                        "[info] command running... {}s elapsed\n",
                        elapsed_secs
                    )),
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                );
            }
        })
    });

    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(err)) => {
            heartbeat_stop.store(true, Ordering::Relaxed);
            if let Some(task) = heartbeat_task.take() {
                let _ = task.await;
            }
            let stdout = await_cli_stream_task(stdout_task, "stdout")
                .await
                .unwrap_or_default();
            let stderr = await_cli_stream_task(stderr_task, "stderr")
                .await
                .unwrap_or_default();
            let detail = if stderr.trim().is_empty() {
                stdout.trim().to_string()
            } else {
                stderr.trim().to_string()
            };
            return Err(format!(
                "failed to execute {label}: selected CLI '{selected_cli}' resolved to command '{command}' ({command_source}{path_hint}) with error: {err}. {detail}"
            ));
        }
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            heartbeat_stop.store(true, Ordering::Relaxed);
            if let Some(task) = heartbeat_task.take() {
                let _ = task.await;
            }
            let stdout = await_cli_stream_task(stdout_task, "stdout")
                .await
                .unwrap_or_default();
            let stderr = await_cli_stream_task(stderr_task, "stderr")
                .await
                .unwrap_or_default();
            let streamed = streamed_chunk_count.load(Ordering::Relaxed);
            if allow_timeout_output_recovery {
                if let Some(context) = phase12_agent_context {
                    emit_cli_command_event(
                        context,
                        CliCommandLogKind::CommandFinished,
                        command_id.clone(),
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                    );
                }
                return Ok(CliExecutionResult {
                    stdout,
                    stderr,
                    command_id,
                    streamed_chunk_count: streamed,
                    timed_out: true,
                });
            }
            if let Some(context) = phase12_agent_context {
                emit_cli_command_event(
                    context,
                    CliCommandLogKind::CommandFinished,
                    command_id.clone(),
                    None,
                    Some(format!(
                        "{label} timed out after {} seconds",
                        timeout.as_secs()
                    )),
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                );
            }
            return Err(format!(
                "{label} timed out after {} seconds",
                timeout.as_secs()
            ));
        }
    };

    heartbeat_stop.store(true, Ordering::Relaxed);
    if let Some(task) = heartbeat_task.take() {
        let _ = task.await;
    }

    let stdout = await_cli_stream_task(stdout_task, "stdout").await?;
    let stderr = await_cli_stream_task(stderr_task, "stderr").await?;
    let streamed = streamed_chunk_count.load(Ordering::Relaxed);
    let exit_code = status.code();
    let command_id_for_return = command_id.clone();

    if let Some(context) = phase12_agent_context {
        emit_cli_command_event(
            context,
            CliCommandLogKind::CommandFinished,
            command_id,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            exit_code,
        );
    }

    if !status.success() {
        let code = exit_code.unwrap_or(-1);
        let detail = if stderr.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            stderr.trim().to_string()
        };
        return Err(format!(
            "{label} selected CLI '{selected_cli}' resolved to command '{command}' ({command_source}{path_hint}) failed with exit code {code}: {detail}"
        ));
    }

    Ok(CliExecutionResult {
        stdout,
        stderr,
        command_id: command_id_for_return,
        streamed_chunk_count: streamed,
        timed_out: false,
    })
}

fn sanitize_json_escapes(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(&next_c) = chars.peek() {
                match next_c {
                    'u' => {
                        chars.next(); // consume 'u'
                        let mut hex = String::new();
                        for _ in 0..4 {
                            if let Some(&hc) = chars.peek() {
                                if hc.is_ascii_hexdigit() {
                                    hex.push(hc);
                                    chars.next();
                                } else {
                                    break;
                                }
                            }
                        }
                        if hex.len() == 4 {
                            out.push_str("\\u");
                            out.push_str(&hex);
                        } else {
                            // Invalid unicode escape, just emit the raw characters without \u
                            out.push_str(&hex);
                        }
                    }
                    '"' | '\\' | '/' | 'b' | 'f' | 'n' | 'r' | 't' => {
                        out.push('\\');
                        out.push(next_c);
                        chars.next();
                    }
                    _ => {
                        // Invalid escape sequence like \'
                        // Just drop the backslash and keep the character
                        out.push(next_c);
                        chars.next();
                    }
                }
            } else {
                out.push('\\');
            }
        } else {
            out.push(c);
        }
    }

    // Common non-JSON token emitted by some local-model tool wrappers.
    out = out.replace("nullptr", "null");
    repair_malformed_json_key_quotes(&out)
}

fn parse_json_payload<T: for<'de> Deserialize<'de>>(raw: &str) -> Result<T, String> {
    let candidates = collect_json_parse_candidates(raw);
    if candidates.is_empty() {
        let mut raw_snippet = raw.trim().to_string();
        if raw_snippet.len() > 280 {
            raw_snippet.truncate(280);
            raw_snippet.push_str("...");
        }
        return Err(format!(
            "Failed to locate any valid JSON object. stage=candidate_extract candidates=0 Raw: {raw_snippet}"
        ));
    }

    let mut errors: Vec<String> = Vec::new();
    let mut last_valid: Option<T> = None;

    for (idx, candidate) in candidates.iter().enumerate() {
        let candidate_label = format!("candidate#{}", idx + 1);
        match serde_json::from_str::<Value>(candidate) {
            Ok(value) => {
                if let Some(parsed) =
                    try_deserialize_json_candidate::<T>(value, &candidate_label, &mut errors)
                {
                    last_valid = Some(parsed);
                }
            }
            Err(err) => errors.push(format!(
                "stage=candidate_extract {candidate_label} parse_error={err}"
            )),
        }

        let sanitized = sanitize_json_escapes(candidate);
        if sanitized != *candidate {
            match serde_json::from_str::<Value>(&sanitized) {
                Ok(value) => {
                    let sanitized_label = format!("{candidate_label}:sanitized");
                    if let Some(parsed) = try_deserialize_json_candidate::<T>(
                        value,
                        sanitized_label.as_str(),
                        &mut errors,
                    ) {
                        last_valid = Some(parsed);
                    }
                }
                Err(err) => errors.push(format!(
                    "stage=sanitize {candidate_label} parse_error={err}"
                )),
            }
        }

        let newline_repaired = repair_unescaped_newlines_in_json_strings(&sanitized);
        if newline_repaired != sanitized {
            match serde_json::from_str::<Value>(&newline_repaired) {
                Ok(value) => {
                    let repaired_label = format!("{candidate_label}:newline_repair");
                    if let Some(parsed) = try_deserialize_json_candidate::<T>(
                        value,
                        repaired_label.as_str(),
                        &mut errors,
                    ) {
                        last_valid = Some(parsed);
                    }
                }
                Err(err) => errors.push(format!(
                    "stage=newline_repair {candidate_label} parse_error={err}"
                )),
            }
        }
    }

    if let Some(parsed) = last_valid {
        return Ok(parsed);
    }

    let mut raw_snippet = raw.trim().to_string();
    if raw_snippet.len() > 280 {
        raw_snippet.truncate(280);
        raw_snippet.push_str("...");
    }
    let top_errors = if errors.is_empty() {
        "stage=deserialize no successful candidate".to_string()
    } else {
        errors.into_iter().take(3).collect::<Vec<_>>().join(" | ")
    };

    Err(format!(
        "Failed to locate any valid JSON object. candidates={} {}. Raw: {}",
        candidates.len(),
        top_errors,
        raw_snippet
    ))
}

fn extract_json(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some(code_block) = extract_json_code_block(trimmed) {
        let code_trimmed = code_block.trim();
        if code_trimmed.starts_with('{') && code_trimmed.ends_with('}') {
            return Some(code_trimmed.to_string());
        }
    }

    let balanced = extract_balanced_json_objects(trimmed);
    if let Some(last) = balanced.last() {
        return Some(last.clone());
    }

    // Legacy fallback for noisy wrappers where balancing could not recover.
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;

    if end <= start {
        return None;
    }

    Some(trimmed[start..=end].to_string())
}

fn collect_json_parse_candidates(raw: &str) -> Vec<String> {
    let mut candidates = Vec::<String>::new();
    let mut seen = HashSet::<String>::new();

    let push_candidate = |value: &str, candidates: &mut Vec<String>, seen: &mut HashSet<String>| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return;
        }
        if seen.insert(trimmed.to_string()) {
            candidates.push(trimmed.to_string());
        }
    };

    let trimmed = raw.trim();
    push_candidate(trimmed, &mut candidates, &mut seen);

    if let Some(code_block) = extract_json_code_block(trimmed) {
        push_candidate(&code_block, &mut candidates, &mut seen);
    }

    for event_candidate in extract_event_stream_json_candidates(trimmed) {
        push_candidate(&event_candidate, &mut candidates, &mut seen);
    }

    for object in extract_balanced_json_objects(trimmed) {
        push_candidate(&object, &mut candidates, &mut seen);
    }

    candidates
}

fn extract_json_code_block(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if !trimmed.starts_with("```") {
        return None;
    }
    let without_prefix = trimmed
        .trim_start_matches("```json")
        .trim_start_matches("```JSON")
        .trim_start_matches("```")
        .trim();
    let without_suffix = without_prefix.trim_end_matches("```").trim();
    if without_suffix.is_empty() {
        None
    } else {
        Some(without_suffix.to_string())
    }
}

fn extract_balanced_json_objects(raw: &str) -> Vec<String> {
    let mut objects = Vec::<String>::new();
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escape = false;
    let mut start_index: Option<usize> = None;

    for (idx, ch) in raw.char_indices() {
        if in_string {
            if escape {
                escape = false;
                continue;
            }
            if ch == '\\' {
                escape = true;
                continue;
            }
            if ch == '"' {
                in_string = false;
            }
            continue;
        }

        if ch == '"' {
            in_string = true;
            continue;
        }

        if ch == '{' {
            if depth == 0 {
                start_index = Some(idx);
            }
            depth += 1;
            continue;
        }

        if ch == '}' && depth > 0 {
            depth -= 1;
            if depth == 0 {
                if let Some(start) = start_index.take() {
                    let end = idx + ch.len_utf8();
                    objects.push(raw[start..end].to_string());
                }
            }
        }
    }

    objects
}

fn repair_malformed_json_key_quotes(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut repaired = String::with_capacity(raw.len());
    let mut in_string = false;
    let mut escape = false;
    let mut index = 0usize;
    let mut last_emitted_non_whitespace: Option<char> = None;

    while index < chars.len() {
        let ch = chars[index];
        if in_string {
            repaired.push(ch);
            if !ch.is_whitespace() {
                last_emitted_non_whitespace = Some(ch);
            }
            if escape {
                escape = false;
                index += 1;
                continue;
            }
            if ch == '\\' {
                escape = true;
                index += 1;
                continue;
            }
            if ch == '"' {
                in_string = false;
            }
            index += 1;
            continue;
        }

        if ch == '"' {
            let mut lookahead = index + 1;
            while lookahead < chars.len() && chars[lookahead].is_whitespace() {
                lookahead += 1;
            }
            if lookahead < chars.len()
                && chars[lookahead] == ':'
                && last_emitted_non_whitespace == Some('"')
            {
                index += 1;
                continue;
            }
            in_string = true;
        }

        repaired.push(ch);
        if !ch.is_whitespace() {
            last_emitted_non_whitespace = Some(ch);
        }
        index += 1;
    }

    repaired
}

fn repair_unescaped_newlines_in_json_strings(raw: &str) -> String {
    let mut repaired = String::with_capacity(raw.len());
    let mut in_string = false;
    let mut escape = false;

    for ch in raw.chars() {
        if in_string {
            if escape {
                repaired.push(ch);
                escape = false;
                continue;
            }
            match ch {
                '\\' => {
                    repaired.push(ch);
                    escape = true;
                }
                '"' => {
                    repaired.push(ch);
                    in_string = false;
                }
                '\n' | '\r' => {
                    if !repaired.ends_with(' ') {
                        repaired.push(' ');
                    }
                }
                _ => repaired.push(ch),
            }
            continue;
        }

        if ch == '"' {
            in_string = true;
        }
        repaired.push(ch);
    }

    repaired
}

fn extract_event_stream_json_candidates(raw: &str) -> Vec<String> {
    let mut candidates = Vec::<String>::new();
    let mut seen = HashSet::<String>::new();
    let push = |value: &str, candidates: &mut Vec<String>, seen: &mut HashSet<String>| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return;
        }
        if seen.insert(trimmed.to_string()) {
            candidates.push(trimmed.to_string());
        }
    };

    let push_string_field = |obj: &serde_json::Map<String, Value>,
                             key: &str,
                             candidates: &mut Vec<String>,
                             seen: &mut HashSet<String>| {
        if let Some(text) = obj.get(key).and_then(Value::as_str) {
            push(text, candidates, seen);
        }
    };

    for line in raw.lines() {
        if candidates.len() >= 24 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if looks_like_known_phase_payload(&value) {
            push(&value.to_string(), &mut candidates, &mut seen);
        }
        let Some(object) = value.as_object() else {
            continue;
        };

        push_string_field(object, "text", &mut candidates, &mut seen);
        push_string_field(object, "content", &mut candidates, &mut seen);
        push_string_field(object, "message", &mut candidates, &mut seen);
        push_string_field(object, "output", &mut candidates, &mut seen);
        push_string_field(object, "response", &mut candidates, &mut seen);
        push_string_field(object, "result", &mut candidates, &mut seen);

        if let Some(item) = object.get("item").and_then(Value::as_object) {
            push_string_field(item, "text", &mut candidates, &mut seen);
            push_string_field(item, "content", &mut candidates, &mut seen);
        }

        if let Some(part) = object.get("part").and_then(Value::as_object) {
            push_string_field(part, "text", &mut candidates, &mut seen);
            push_string_field(part, "content", &mut candidates, &mut seen);
        }

        if let Some(content) = object.get("content").and_then(Value::as_array) {
            for entry in content {
                if let Some(text) = entry.get("text").and_then(Value::as_str) {
                    push(text, &mut candidates, &mut seen);
                }
            }
        }
    }

    candidates
}

fn unwrap_known_model_json_envelopes(mut parsed: Value) -> Value {
    for _ in 0..4 {
        let Some(obj) = parsed.as_object().cloned() else {
            return parsed;
        };

        if obj.contains_key("name") && obj.contains_key("parameters") {
            if let Some(parameters) = obj.get("parameters") {
                parsed = parameters.clone();
                continue;
            }
        }

        if let Some(response) = obj.get("response") {
            match response {
                Value::String(content) => {
                    if let Ok(decoded) = serde_json::from_str::<Value>(content) {
                        parsed = decoded;
                        continue;
                    }
                }
                Value::Object(_) | Value::Array(_) => {
                    parsed = response.clone();
                    continue;
                }
                _ => {}
            }
        }

        if let Some(item) = obj.get("item").and_then(Value::as_object) {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                if let Ok(decoded) = serde_json::from_str::<Value>(text) {
                    parsed = decoded;
                    continue;
                }
            }
        }

        if let Some(part) = obj.get("part").and_then(Value::as_object) {
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                if let Ok(decoded) = serde_json::from_str::<Value>(text) {
                    parsed = decoded;
                    continue;
                }
            }
        }

        for field in ["text", "content", "message", "output", "result"] {
            if let Some(text) = obj.get(field).and_then(Value::as_str) {
                if let Ok(decoded) = serde_json::from_str::<Value>(text) {
                    parsed = decoded;
                    continue;
                }
            }
        }

        return parsed;
    }
    parsed
}

fn try_deserialize_json_candidate<T: for<'de> Deserialize<'de>>(
    value: Value,
    candidate_label: &str,
    errors: &mut Vec<String>,
) -> Option<T> {
    let unwrapped = unwrap_known_model_json_envelopes(value);
    if !looks_like_known_phase_payload(&unwrapped) {
        let mut raw_snippet = unwrapped.to_string();
        if raw_snippet.len() > 260 {
            raw_snippet.truncate(260);
            raw_snippet.push_str("...");
        }
        errors.push(format!(
            "stage=deserialize {candidate_label} missing_expected_keys raw={raw_snippet}"
        ));
        return None;
    }
    match serde_json::from_value::<T>(unwrapped.clone()) {
        Ok(parsed) => Some(parsed),
        Err(err) => {
            let mut raw_snippet = unwrapped.to_string();
            if raw_snippet.len() > 260 {
                raw_snippet.truncate(260);
                raw_snippet.push_str("...");
            }
            errors.push(format!(
                "stage=deserialize {candidate_label} error={err} raw={raw_snippet}"
            ));
            None
        }
    }
}

fn should_retry_opencode_json_parse(err: &str) -> bool {
    err.contains("Failed to locate any valid JSON object")
        || err.contains("JSON valid but empty response payload")
        || err.contains("JSON valid but empty plan payload")
}

fn compact_cli_parse_error(err: &str) -> String {
    let mut normalized = err.split_whitespace().collect::<Vec<_>>().join(" ");
    if let Some(raw_index) = normalized.find(" Raw:") {
        normalized.truncate(raw_index);
    }
    truncate(&normalized, 110)
}

fn strict_json_retry_prompt(prompt: &str) -> String {
    format!(
        "{prompt}\n\nIMPORTANT: Return exactly one valid JSON object matching the required schema. Do not call tools. Do not ask follow-up questions via any wrapper. No markdown. No code fences. No extra text."
    )
}

fn parse_json_style_string_literal(raw: &str, quote_index: usize) -> Option<(String, usize)> {
    let bytes = raw.as_bytes();
    if quote_index >= bytes.len() || bytes[quote_index] != b'"' {
        return None;
    }

    let mut output = String::new();
    let mut escape = false;
    let suffix = &raw[quote_index + 1..];

    for (offset, ch) in suffix.char_indices() {
        if escape {
            let decoded = match ch {
                '"' => '"',
                '\\' => '\\',
                '/' => '/',
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                'b' => '\u{0008}',
                'f' => '\u{000C}',
                other => other,
            };
            output.push(decoded);
            escape = false;
            continue;
        }
        if ch == '\\' {
            escape = true;
            continue;
        }
        if ch == '"' {
            let next_index = quote_index + 1 + offset + ch.len_utf8();
            return Some((output, next_index));
        }
        output.push(ch);
    }

    None
}

fn extract_json_style_string_fields(raw: &str, field: &str, limit: usize) -> Vec<String> {
    let mut values = Vec::<String>::new();
    if field.trim().is_empty() || limit == 0 {
        return values;
    }

    let needle = format!("\"{field}\"");
    let bytes = raw.as_bytes();
    let mut search_start = 0usize;

    while search_start < raw.len() && values.len() < limit {
        let Some(rel) = raw[search_start..].find(&needle) else {
            break;
        };
        let key_start = search_start + rel;
        let mut cursor = key_start + needle.len();

        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() || bytes[cursor] != b':' {
            search_start = key_start + needle.len();
            continue;
        }
        cursor += 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() || bytes[cursor] != b'"' {
            search_start = key_start + needle.len();
            continue;
        }

        if let Some((value, next_index)) = parse_json_style_string_literal(raw, cursor) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                values.push(trimmed.to_string());
            }
            search_start = next_index;
        } else {
            search_start = cursor + 1;
        }
    }

    values
}

fn first_sentence_like_text(raw: &str, max_len: usize) -> Option<String> {
    let normalized = raw
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();
    if normalized.is_empty() {
        return None;
    }
    let sentence_end = normalized
        .char_indices()
        .find_map(|(idx, ch)| match ch {
            '.' | '!' | '?' => Some(idx + ch.len_utf8()),
            _ => None,
        })
        .unwrap_or(normalized.len());
    let slice = normalized[..sentence_end].trim();
    if slice.is_empty() {
        return None;
    }
    Some(truncate(slice, max_len))
}

fn parse_json_string_array(raw: &str, limit: usize) -> Vec<String> {
    if limit == 0 {
        return Vec::new();
    }

    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let parse_attempt = serde_json::from_str::<Value>(trimmed)
        .ok()
        .or_else(|| serde_json::from_str::<Value>(&sanitize_json_escapes(trimmed)).ok());

    let mut values = Vec::<String>::new();
    if let Some(Value::Array(items)) = parse_attempt {
        for item in items {
            if values.len() >= limit {
                break;
            }
            if let Some(text) = item.as_str() {
                let cleaned = text.trim();
                if !cleaned.is_empty() && !values.iter().any(|existing| existing == cleaned) {
                    values.push(cleaned.to_string());
                }
            }
        }
    }

    values
}

fn coerce_agent_response_from_raw(raw: &str) -> Option<AgentResponse> {
    let raw_trimmed = raw.trim();
    if raw_trimmed.is_empty() {
        return None;
    }

    let interpretation_field = extract_json_style_string_fields(raw, "interpretation", 1)
        .into_iter()
        .next();
    let mut interpretation = interpretation_field
        .or_else(|| first_sentence_like_text(raw, 220))
        .unwrap_or_else(|| {
            "Non-JSON CLI output received; fallback interpretation generated.".to_string()
        });

    if interpretation.trim().is_empty()
        || interpretation.starts_with('{')
        || interpretation.starts_with('[')
    {
        interpretation =
            "Non-JSON tool wrapper detected; fallback interpretation generated from raw output."
                .to_string();
    }

    let mut questions = extract_json_style_string_fields(raw, "header", 3);
    questions.extend(extract_json_style_string_fields(raw, "question", 3));
    for serialized in extract_json_style_string_fields(raw, "q", 2) {
        questions.extend(parse_json_string_array(&serialized, 3));
    }
    questions = questions
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .fold(Vec::<String>::new(), |mut acc, item| {
            if !acc.iter().any(|existing| existing == &item) {
                acc.push(item);
            }
            acc
        });
    if questions.len() > 3 {
        questions.truncate(3);
    }
    if questions.is_empty() {
        questions.push(
            "Quels sont les critères de succès et les contraintes non négociables ?".to_string(),
        );
    }

    let approach = extract_json_style_string_fields(raw, "approach", 1)
        .into_iter()
        .next()
        .unwrap_or_else(|| {
            "Fallback generated from non-JSON OpenCode output; review recommended.".to_string()
        });

    Some(AgentResponse {
        interpretation,
        assumptions: Vec::new(),
        risks: Vec::new(),
        questions,
        approach,
    })
}

fn coerce_agent_plan_from_raw(raw: &str) -> Option<AgentPlan> {
    let raw_trimmed = raw.trim();
    if raw_trimmed.is_empty() {
        return None;
    }

    let architecture = extract_json_style_string_fields(raw, "architecture", 1)
        .into_iter()
        .next()
        .or_else(|| first_sentence_like_text(raw, 240))
        .unwrap_or_else(|| "Fallback architecture generated from non-JSON CLI output.".to_string());
    let architecture = if architecture.trim().is_empty() {
        "Fallback architecture generated from non-JSON CLI output.".to_string()
    } else {
        architecture
    };

    let mut stack = extract_json_style_string_fields(raw, "label", 6)
        .into_iter()
        .filter(|value| {
            let lower = value.to_lowercase();
            !lower.contains("recommended")
                && !lower.contains("optional")
                && !lower.contains("true")
                && !lower.contains("false")
        })
        .collect::<Vec<_>>();
    let stack_hints = [
        ("react", "React"),
        ("angular", "Angular"),
        ("vue", "Vue.js"),
        ("node", "Node.js"),
        ("express", "Express"),
        ("nestjs", "NestJS"),
        ("typescript", "TypeScript"),
        ("postgres", "PostgreSQL"),
        ("redis", "Redis"),
    ];
    for (needle, label) in stack_hints {
        if raw.to_lowercase().contains(needle) && !stack.iter().any(|item| item == label) {
            stack.push(label.to_string());
        }
    }
    if stack.is_empty() {
        stack.push("TypeScript".to_string());
        stack.push("Node.js".to_string());
    }
    if stack.len() > 6 {
        stack.truncate(6);
    }

    Some(AgentPlan {
        problem_read: first_sentence_like_text(raw, 220).unwrap_or_else(|| {
            "Fallback problem framing generated from non-JSON CLI output.".to_string()
        }),
        main_hypothesis: first_sentence_like_text(raw, 160).unwrap_or_else(|| {
            "Fallback hypothesis generated from non-JSON CLI output.".to_string()
        }),
        strategy: architecture.clone(),
        next_steps: vec![
            "Clarify scope and constraints.".to_string(),
            "Run the smallest meaningful investigation or implementation step.".to_string(),
            "Review findings and adjust the chosen direction.".to_string(),
        ],
        risks: vec!["Output was non-JSON; this approach brief is auto-coerced.".to_string()],
        open_questions: vec![],
        stack,
        phases: vec![PlanPhase {
            name: "Fallback implementation plan".to_string(),
            duration: "0.5j".to_string(),
            tasks: vec![
                "Clarify functional scope and constraints".to_string(),
                "Implement minimal baseline and validate behavior".to_string(),
            ],
        }],
        architecture,
        tradeoffs: vec!["Output was non-JSON; this plan is auto-coerced.".to_string()],
        warnings: vec!["Review and adjust manually before execution.".to_string()],
    })
}

fn looks_like_known_phase_payload(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.is_empty() {
        return false;
    }
    const KNOWN_KEYS: [&str; 20] = [
        "interpretation",
        "assumptions",
        "risks",
        "questions",
        "approach",
        "problem_read",
        "problemRead",
        "main_hypothesis",
        "mainHypothesis",
        "strategy",
        "next_steps",
        "nextSteps",
        "open_questions",
        "openQuestions",
        "stack",
        "phases",
        "architecture",
        "tradeoffs",
        "warnings",
        "attack_report",
    ];
    KNOWN_KEYS.iter().any(|key| object.contains_key(*key))
}

fn extract_code_block(raw: &str) -> String {
    let trimmed = raw.trim();

    if trimmed.starts_with("```") {
        let without_lang = trimmed
            .trim_start_matches("```ts")
            .trim_start_matches("```typescript")
            .trim_start_matches("```tsx")
            .trim_start_matches("```js")
            .trim_start_matches("```")
            .trim();
        return without_lang.trim_end_matches("```").trim().to_string();
    }

    trimmed.to_string()
}

fn truncate(value: &str, max_len: usize) -> String {
    if value.chars().count() <= max_len {
        return value.to_string();
    }

    let mut output = String::with_capacity(max_len + 3);
    for ch in value.chars().take(max_len) {
        output.push(ch);
    }
    output.push_str("...");
    output
}

fn infer_domain(requirement: &str) -> &'static str {
    let req = requirement.to_lowercase();
    if req.contains("auth")
        || req.contains("authentification")
        || req.contains("jwt")
        || req.contains("login")
        || req.contains("password")
        || req.contains("mot de passe")
    {
        "auth"
    } else if req.contains("payment")
        || req.contains("paiement")
        || req.contains("checkout")
        || req.contains("carte")
        || req.contains("idempotency")
    {
        "payment"
    } else if req.contains("notification")
        || req.contains("email")
        || req.contains("push")
        || req.contains("sms")
    {
        "notifications"
    } else if req.contains("analytics")
        || req.contains("dashboard")
        || req.contains("metri")
        || req.contains("temps reel")
        || req.contains("real time")
    {
        "analytics"
    } else {
        "other"
    }
}

fn architect_phases() -> Vec<PlanPhase> {
    vec![
        PlanPhase {
            name: "Spécification exécutable".to_string(),
            duration: "0.5j".to_string(),
            tasks: vec![
                "Normaliser les critères d'acceptation".to_string(),
                "Cartographier risques et contrôles".to_string(),
            ],
        },
        PlanPhase {
            name: "Architecture et contrats".to_string(),
            duration: "1j".to_string(),
            tasks: vec![
                "Définir interfaces entre agents et orchestrateur".to_string(),
                "Valider persistance session + ADR".to_string(),
            ],
        },
        PlanPhase {
            name: "Implémentation incrémentale".to_string(),
            duration: "2j".to_string(),
            tasks: vec![
                "Livrer slice vertical end-to-end".to_string(),
                "Ajouter instrumentation et audits".to_string(),
            ],
        },
    ]
}

fn pragmatist_phases() -> Vec<PlanPhase> {
    vec![
        PlanPhase {
            name: "MVP duel agents".to_string(),
            duration: "0.5j".to_string(),
            tasks: vec![
                "Wire input requirement + réponses brutes".to_string(),
                "Afficher divergences clés".to_string(),
            ],
        },
        PlanPhase {
            name: "Plans comparés".to_string(),
            duration: "1j".to_string(),
            tasks: vec![
                "Ajouter clarifications utilisateur".to_string(),
                "Générer plans et résumé de décision".to_string(),
            ],
        },
        PlanPhase {
            name: "Polish livrable".to_string(),
            duration: "0.5j".to_string(),
            tasks: vec![
                "Export JSON session".to_string(),
                "Documenter setup développeur".to_string(),
            ],
        },
    ]
}

fn mock_response(role: AgentRole, requirement: &str) -> AgentResponse {
    let domain = infer_domain(requirement);
    match role {
        AgentRole::Architect => AgentResponse {
            interpretation: "Je traite ce requirement comme une décision système, pas un ticket isolé. Les invariants doivent être explicites avant implémentation.".to_string(),
            assumptions: vec![
                "Le système doit rester maintenable sur plusieurs releases.".to_string(),
                format!("Le domaine principal semble être '{domain}'."),
                "Les arbitrages doivent être journalisés pour audit.".to_string(),
            ],
            risks: vec![
                "Ambiguïtés de spec non résolues avant codage.".to_string(),
                "Couverture insuffisante des cas d'échec en production.".to_string(),
            ],
            questions: vec![
                "Quels critères de succès sont non négociables ?".to_string(),
                "Quel niveau de traçabilité est attendu pour chaque décision ?".to_string(),
            ],
            approach: "Architecture modulaire avec interfaces stables, suivi des décisions, puis livraison incrémentale.".to_string(),
        },
        AgentRole::Pragmatist => AgentResponse {
            interpretation: "Je vise un flux MVP opérationnel rapidement: requirement, double analyse, puis arbitrage. Les optimisations avancées arrivent après validation d'usage.".to_string(),
            assumptions: vec![
                "Le MVP couvre d'abord les phases 1 et 2.".to_string(),
                format!("Le requirement appartient majoritairement au domaine '{domain}'."),
                "Le format JSON de session doit rester simple.".to_string(),
            ],
            risks: vec![
                "Sur-ingénierie avant validation utilisateur.".to_string(),
                "Explosion de coûts API si prompts non cadrés.".to_string(),
            ],
            questions: vec![
                "Combien de divergences max veut-on afficher sans noyer l'utilisateur ?".to_string(),
                "Le stockage local est-il obligatoire sur toutes les sessions ?".to_string(),
            ],
            approach: "Construire un socle lisible et stable, itérer vite sur l'utilité perçue des divergences.".to_string(),
        },
    }
}

fn mock_plan(role: AgentRole, requirement: &str, clarifications: &str) -> AgentPlan {
    let domain = infer_domain(requirement);
    let has_clarifications = !clarifications.trim().is_empty();

    match role {
        AgentRole::Architect => AgentPlan {
            problem_read: "Treat the problem as a system decision that needs explicit invariants before action.".to_string(),
            main_hypothesis: "A tighter framing and explicit constraints will reduce downstream disagreement cost.".to_string(),
            strategy: "Stabilize the problem frame first, then sequence a small set of high-leverage actions with explicit tradeoffs.".to_string(),
            next_steps: vec![
                "Clarify success criteria and non-negotiable constraints.".to_string(),
                "Pick the safest baseline direction and note what is intentionally deferred.".to_string(),
                "Run one proof step to validate the chosen direction.".to_string(),
            ],
            risks: vec![
                "Key constraints may still be implicit.".to_string(),
                "An attractive short-term path may hide operational cost.".to_string(),
            ],
            open_questions: vec![
                "What must be true for the decision to be considered successful?".to_string(),
                "Which failure mode is least acceptable in production?".to_string(),
            ],
            stack: vec![
                "Tauri".to_string(),
                "React".to_string(),
                "Rust".to_string(),
                "SQLite".to_string(),
                format!("domain:{domain}"),
            ],
            phases: architect_phases(),
            architecture: "Le frontend orchestre les phases. Le backend Rust encapsule providers LLM, opérations Git et export session standardisé.".to_string(),
            tradeoffs: vec![
                "Plus de structure upfront, meilleure fiabilité long-terme.".to_string(),
                "Isolation stricte des agents augmente la latence mais réduit les biais de contamination.".to_string(),
            ],
            warnings: vec![
                "Versionner les prompts pour garantir des comparaisons cohérentes.".to_string(),
                "Encadrer la phase 3 avec sandbox Git dédiée.".to_string(),
            ],
        },
        AgentRole::Pragmatist => AgentPlan {
            problem_read: "Treat the problem as something to unblock quickly with the smallest useful move.".to_string(),
            main_hypothesis: "A narrow first move plus fast feedback will outperform a broad upfront design.".to_string(),
            strategy: "Choose the shortest path that reveals whether the current direction is good enough, then iterate from evidence.".to_string(),
            next_steps: vec![
                "Define the smallest test or action that can reduce uncertainty now.".to_string(),
                "Execute that step and observe what changes.".to_string(),
                "Keep only the follow-up work justified by the new evidence.".to_string(),
            ],
            risks: vec![
                "Fast moves can hide systemic issues if no rollback is defined.".to_string(),
                if has_clarifications {
                    "Clarifications may still be interpreted too loosely.".to_string()
                } else {
                    "The direction still depends on unstated assumptions.".to_string()
                },
            ],
            open_questions: vec![
                "What is the minimum proof we need before committing more time?".to_string(),
            ],
            stack: vec![
                "Tauri".to_string(),
                "React".to_string(),
                "Tailwind".to_string(),
                "Shadcn-style components".to_string(),
                format!("domain:{domain}"),
            ],
            phases: pragmatist_phases(),
            architecture: "Frontend simple state-machine, backend Rust pour commandes critiques. Les providers LLM restent interchangeables via une couche provider agnostique.".to_string(),
            tradeoffs: vec![
                "Livraison rapide avec dette technique contrôlée.".to_string(),
                "Moins de couverture exhaustive au départ, plus d'itération terrain.".to_string(),
            ],
            warnings: vec![
                "Ne pas démarrer phase 3 sans logs fiables phase 1/2.".to_string(),
                if has_clarifications {
                    "Vérifier que les clarifications client sont reflétées dans l'arbitrage final.".to_string()
                } else {
                    "Le plan repose sur des hypothèses fortes faute de clarifications.".to_string()
                },
            ],
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn phase1_payload(interpretation: &str) -> String {
        format!(
            "{{\"interpretation\":\"{interpretation}\",\"assumptions\":[\"a\"],\"risks\":[\"r\"],\"questions\":[\"q\"],\"approach\":\"p\"}}"
        )
    }

    fn env_test_lock() -> std::sync::MutexGuard<'static, ()> {
        static ENV_GUARD: OnceLock<Mutex<()>> = OnceLock::new();
        ENV_GUARD
            .get_or_init(|| Mutex::new(()))
            .lock()
            .expect("env guard lock")
    }

    #[test]
    fn parse_json_payload_preserves_compact_array_keys() {
        let raw = phase1_payload("compact");
        let parsed: AgentResponse = parse_json_payload(&raw).expect("compact JSON should parse");
        assert_eq!(parsed.interpretation, "compact");
        assert_eq!(parsed.assumptions, vec!["a"]);
        assert_eq!(parsed.risks, vec!["r"]);
        assert_eq!(parsed.questions, vec!["q"]);
        assert_eq!(parsed.approach, "p");
    }

    #[test]
    fn parse_json_payload_repairs_key_double_quote_and_nullptr() {
        let raw = "{\"interpretation\":\"fixed\",\"assumptions\"\": [\"a\"],\"risks\"\": [\"r\"],\"questions\"\": [\"q\"],\"approach\":\"p\",\"meta\":nullptr}";
        let parsed: AgentResponse =
            parse_json_payload(raw).expect("malformed key quote/ nullptr should be repaired");
        assert_eq!(parsed.interpretation, "fixed");
        assert_eq!(parsed.assumptions, vec!["a"]);
        assert_eq!(parsed.risks, vec!["r"]);
        assert_eq!(parsed.questions, vec!["q"]);
    }

    #[test]
    fn parse_json_payload_uses_last_valid_json_object() {
        let first = phase1_payload("first");
        let second = phase1_payload("last");
        let raw = format!("{first}\n{second}");
        let parsed: AgentResponse =
            parse_json_payload(&raw).expect("multiple JSON objects should parse");
        assert_eq!(parsed.interpretation, "last");
    }

    #[test]
    fn parse_json_payload_unwraps_response_envelope() {
        let envelope = serde_json::json!({
            "response": phase1_payload("enveloped")
        })
        .to_string();
        let parsed: AgentResponse =
            parse_json_payload(&envelope).expect("response envelope should be unwrapped");
        assert_eq!(parsed.interpretation, "enveloped");
    }

    #[test]
    fn parse_json_payload_handles_jsonl_event_wrapped_agent_message() {
        let raw = concat!(
            "{\"type\":\"thread.started\",\"thread_id\":\"abc\"}\n",
            "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_1\",\"type\":\"agent_message\",\"text\":\"{\\\"interpretation\\\":\\\"stream\\\",\\\"assumptions\\\":[\\\"a\\\"],\\\"risks\\\":[\\\"r\\\"],\\\"questions\\\":[\\\"q\\\"],\\\"approach\\\":\\\"p\\\"}\"}}\n"
        );
        let parsed: AgentResponse =
            parse_json_payload(raw).expect("jsonl wrapped agent message should parse");
        assert_eq!(parsed.interpretation, "stream");
        assert_eq!(parsed.assumptions, vec!["a"]);
    }

    #[test]
    fn parse_json_payload_repairs_unescaped_newlines_inside_string_values() {
        let raw = "{\n  \"interpretation\": \"Identifier\nla stack rapidement.\",\n  \"assumptions\": [\"a\"],\n  \"risks\": [\"r\"],\n  \"questions\": [\"q\"],\n  \"approach\": \"p\"\n}";
        let parsed: AgentResponse = parse_json_payload(raw)
            .expect("unescaped newlines inside JSON string values should be repaired");
        assert!(parsed.interpretation.contains("Identifier"));
        assert!(parsed.interpretation.contains("la stack"));
    }

    #[test]
    fn parse_json_payload_rejects_tool_wrapper_only_payload() {
        let wrapper = serde_json::json!({
            "name": "json",
            "parameters": {
                "q": "[\"question 1\", \"question 2\"]"
            }
        })
        .to_string();
        let err = parse_json_payload::<AgentResponse>(&wrapper)
            .expect_err("tool wrapper payload should not deserialize as phase response");
        assert!(
            err.contains("Failed to locate any valid JSON object"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn parse_json_payload_rejects_empty_object_payload() {
        let err = parse_json_payload::<AgentResponse>("{}")
            .expect_err("empty payload should not deserialize as phase response");
        assert!(
            err.contains("Failed to locate any valid JSON object"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn coerce_agent_response_from_tool_wrapper_payload() {
        let raw = r#"{"name":"question","parameters":{"questions":[{"header":"Quelle stack front ?","options":[{"label":"React"},{"label":"Vue.js"}]}]}}"#;
        let response = coerce_agent_response_from_raw(raw)
            .expect("tool wrapper payload should coerce to a fallback response");
        assert!(!response.interpretation.trim().is_empty());
        assert!(!response.approach.trim().is_empty());
        assert!(
            !response.questions.is_empty(),
            "expected fallback questions extracted from header"
        );
    }

    #[test]
    fn coerce_agent_response_handles_malformed_question_wrapper() {
        let raw = r#"{"name": "question", "parameters": {"custom":"true","multiple":"false","questions":[{"header":"Quelle est la technologie Stack à utiliser ?","type":"select","options":[{"label":\"React\",\"description\": \"Simple, efficient and feature-rich. \\", \"Recommendation\": \"Recommended\"},{\"label\":\"Angular\",\"description\": \"Full-featured and widely adopted.\", \"Recommendation\": \"Recommended\"}]}}};"#;
        let response = coerce_agent_response_from_raw(raw)
            .expect("malformed question wrapper should still coerce");
        assert!(!response.interpretation.trim().is_empty());
        assert!(
            response.questions.iter().any(|item| item.contains("Stack")),
            "expected question extracted from malformed payload"
        );
    }

    #[test]
    fn coerce_agent_response_extracts_questions_from_q_string_array() {
        let raw =
            r#"{"name":"json","parameters":{"q":"[\"front-end stack?\",\"back-end stack?\"]"}}"#;
        let response =
            coerce_agent_response_from_raw(raw).expect("q field should produce fallback questions");
        assert!(
            response
                .questions
                .iter()
                .any(|item| item.contains("front-end")),
            "expected front-end question from q field"
        );
    }

    #[test]
    fn coerce_agent_plan_from_non_json_text() {
        let raw = "Use React with Node.js and PostgreSQL. Keep architecture simple and modular.";
        let plan =
            coerce_agent_plan_from_raw(raw).expect("plain text should coerce to a fallback plan");
        assert!(!plan.architecture.trim().is_empty());
        assert!(!plan.phases.is_empty());
        assert!(
            plan.stack.iter().any(|item| item == "React"),
            "expected stack hints to include React"
        );
    }

    #[test]
    fn normalize_opencode_json_stream_handles_fragmented_json_text_chunks() {
        let stream = concat!(
            "{\"type\":\"step_start\",\"part\":{\"type\":\"step-start\"}}\n",
            "{\"type\":\"text\",\"part\":{\"text\":\"{\\\"interpretation\\\":\\\"frag\\\"\"}}\n",
            "{\"type\":\"text\",\"part\":{\"text\":\",\\\"assumptions\\\":[\\\"a\\\"],\\\"risks\\\":[\\\"r\\\"],\\\"questions\\\":[\\\"q\\\"],\\\"approach\\\":\\\"p\\\"}\"}}\n",
            "{\"type\":\"step_finish\",\"part\":{\"type\":\"step-finish\"}}\n"
        );
        let normalized = normalize_opencode_json_stream(stream)
            .expect("stream should produce normalized output");
        let parsed: AgentResponse =
            parse_json_payload(&normalized).expect("normalized stream payload should parse");
        assert_eq!(parsed.interpretation, "frag");
        assert_eq!(parsed.assumptions, vec!["a"]);
    }

    #[test]
    fn ensure_opencode_strict_state_home_uses_agent_bucket() {
        let _guard = env_test_lock();
        let root = env::temp_dir().join(format!(
            "friction-opencode-strict-state-test-{}",
            Uuid::new_v4().simple()
        ));
        std::env::set_var(
            "FRICTION_OPENCODE_STRICT_STATE_HOME",
            root.to_string_lossy().to_string(),
        );

        let first = ensure_opencode_strict_state_home(Some("phase12_agent_a"))
            .expect("strict state path for agent a");
        let second = ensure_opencode_strict_state_home(Some("phase12/agent b"))
            .expect("strict state path for agent b");

        assert!(
            first.contains("phase12_agent_a"),
            "unexpected first bucket: {first}"
        );
        assert!(
            second.contains("phase12_agent_b"),
            "unexpected second bucket: {second}"
        );

        std::env::remove_var("FRICTION_OPENCODE_STRICT_STATE_HOME");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cli_models_http_timeout_uses_env_override() {
        let _guard = env_test_lock();
        std::env::set_var("FRICTION_CLI_MODELS_HTTP_TIMEOUT_SECS", "17");
        assert_eq!(cli_models_http_timeout_secs(), 17);
        std::env::remove_var("FRICTION_CLI_MODELS_HTTP_TIMEOUT_SECS");
        assert_eq!(cli_models_http_timeout_secs(), CLI_MODELS_HTTP_TIMEOUT_SECS);
    }

    #[test]
    fn supports_google_generation_model_filters_embedding_only_models() {
        let embedding_only = serde_json::json!({
            "name": "models/text-embedding-004",
            "supportedGenerationMethods": ["embedContent"]
        });
        assert!(!supports_google_generation_model(&embedding_only));

        let generative = serde_json::json!({
            "name": "models/gemini-2.5-pro",
            "supportedGenerationMethods": ["generateContent", "countTokens"]
        });
        assert!(supports_google_generation_model(&generative));
    }

    #[test]
    fn extract_vertex_model_id_handles_full_resource_name() {
        let model = extract_vertex_model_id(
            "projects/p/locations/us-central1/publishers/google/models/gemini-2.5-pro",
        )
        .expect("vertex model id should be extracted");
        assert_eq!(model, "gemini-2.5-pro");
    }

    #[test]
    fn codex_provider_entry_from_config_reads_openai_compatible_provider() {
        let config: toml::Value = toml::from_str(
            r#"
model_provider = "company"

[model_providers.company]
name = "Company"
base_url = "https://llm.company.test/v1"
env_key = "COMPANY_API_KEY"
"#,
        )
        .expect("toml should parse");

        let provider = codex_provider_entry_from_config(&config, "company")
            .expect("provider entry should be resolved");
        assert_eq!(provider.name, "company");
        assert_eq!(provider.base_url, "https://llm.company.test/v1");
        assert_eq!(provider.env_key.as_deref(), Some("COMPANY_API_KEY"));
    }

    #[test]
    fn resolve_codex_selected_provider_prefers_env_override() {
        let _guard = env_test_lock();
        std::env::set_var("CODEX_MODEL_PROVIDER", "custom-provider");
        let selected = resolve_codex_selected_provider_name(None);
        std::env::remove_var("CODEX_MODEL_PROVIDER");
        assert_eq!(selected.0, "custom-provider");
        assert_eq!(selected.1, "env:CODEX_MODEL_PROVIDER");
    }

    #[test]
    fn parse_codex_models_cache_content_extracts_and_dedupes_models() {
        let raw = r#"
{
  "models": [
    { "slug": "gpt-5.3-codex" },
    { "slug": "gpt-5-codex" },
    { "slug": "gpt-5-codex" },
    { "id": "o4-mini" }
  ]
}
"#;
        let models = parse_codex_models_cache_content(raw)
            .expect("codex models cache should parse successfully");
        assert_eq!(
            models,
            vec![
                "gpt-5-codex".to_string(),
                "gpt-5.3-codex".to_string(),
                "o4-mini".to_string()
            ]
        );
    }

    #[test]
    fn parse_claude_models_from_local_usage_extracts_last_model_usage_keys() {
        let raw = r#"
{
  "projects": {
    "/tmp/a": {
      "lastModelUsage": {
        "claude-sonnet-4-6": { "inputTokens": 42 },
        "claude-haiku-4-5-20251001": { "inputTokens": 24 }
      }
    },
    "/tmp/b": {
      "nested": {
        "lastModelUsage": {
          "claude-opus-4-1-20250805": {}
        }
      }
    }
  }
}
"#;
        let models = parse_claude_models_from_local_usage(raw)
            .expect("claude local usage should parse successfully");
        assert_eq!(
            models,
            vec![
                "claude-haiku-4-5-20251001".to_string(),
                "claude-opus-4-1-20250805".to_string(),
                "claude-sonnet-4-6".to_string()
            ]
        );
    }

    #[test]
    fn concise_inventory_fallback_reason_hides_provider_details() {
        let reason = concise_inventory_fallback_reason(
            "codex",
            "mode=openai OPENAI_API_KEY is missing; live Codex model listing is unavailable.",
        );
        assert_eq!(reason, "Codex credentials missing; using fallback presets.");
    }

    #[test]
    fn parse_gemini_models_from_chat_content_extracts_model_fields() {
        let raw = r#"
{
  "events": [
    {
      "role": "assistant",
      "model": "gemini-3-flash-preview",
      "content": "hello"
    },
    {
      "role": "assistant",
      "meta": {
        "model": "gemini-2.5-pro"
      }
    },
    {
      "role": "assistant",
      "model": "not-gemini-model"
    }
  ]
}
"#;
        let models = parse_gemini_models_from_chat_content(raw);
        assert_eq!(
            models,
            vec![
                "gemini-2.5-pro".to_string(),
                "gemini-3-flash-preview".to_string()
            ]
        );
    }
}
