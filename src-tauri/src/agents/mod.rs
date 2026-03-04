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
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
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

Tu reçois un requirement original + des clarifications du client. Produis un plan d'implémentation détaillé.
Réponds UNIQUEMENT en JSON valide:
{
  \"stack\": [\"technologie 1\", \"technologie 2\", \"...\"],
  \"phases\": [
    { \"name\": \"Nom de la phase\", \"duration\": \"estimation\", \"tasks\": [\"tâche 1\", \"tâche 2\"] }
  ],
  \"architecture\": \"Description de l'architecture choisie en 3-4 phrases\",
  \"tradeoffs\": [\"tradeoff ou décision clé 1\", \"tradeoff ou décision clé 2\"],
  \"warnings\": [\"point de vigilance 1\", \"point de vigilance 2\"]
}"#;

const SYSTEM_PRAGMATIST_PLAN: &str = r#"Tu es \"Le Pragmatiste\" — dev orienté livraison rapide, MVP, simplicité.

Tu reçois un requirement original + des clarifications du client. Produis un plan d'implémentation concis.
Réponds UNIQUEMENT en JSON valide:
{
  \"stack\": [\"technologie 1\", \"technologie 2\", \"...\"],
  \"phases\": [
    { \"name\": \"Nom de la phase\", \"duration\": \"estimation\", \"tasks\": [\"tâche 1\", \"tâche 2\"] }
  ],
  \"architecture\": \"Description de l'architecture choisie en 3-4 phrases\",
  \"tradeoffs\": [\"tradeoff ou décision clé 1\", \"tradeoff ou décision clé 2\"],
  \"warnings\": [\"point de vigilance 1\", \"point de vigilance 2\"]
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

const SYSTEM_ADDITIONAL_PLANNER: &str = r#"Tu es un agent de planification indépendant. Tu dois proposer un plan distinct et concret avec un angle complémentaire (performance, sécurité, opérations, coût).

Tu reçois un requirement original + des clarifications du client. Produis un plan d'implémentation détaillé.
Réponds UNIQUEMENT en JSON valide:
{
  \"stack\": [\"technologie 1\", \"technologie 2\", \"...\"],
  \"phases\": [
    { \"name\": \"Nom de la phase\", \"duration\": \"estimation\", \"tasks\": [\"tâche 1\", \"tâche 2\"] }
  ],
  \"architecture\": \"Description de l'architecture choisie en 3-4 phrases\",
  \"tradeoffs\": [\"tradeoff ou décision clé 1\", \"tradeoff ou décision clé 2\"],
  \"warnings\": [\"point de vigilance 1\", \"point de vigilance 2\"]
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
const CLI_MODELS_HTTP_TIMEOUT_SECS: u64 = 2;

static CLI_MODELS_CACHE: OnceLock<Mutex<HashMap<String, CliModelsCacheEntry>>> = OnceLock::new();
static CLI_MODELS_REFRESH_INFLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

#[derive(Debug)]
struct CliExecutionResult {
    stdout: String,
    stderr: String,
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
}

#[derive(Debug, Clone)]
struct CliModelsFetchResult {
    models: Vec<String>,
    source: String,
    reason: Option<String>,
}

#[derive(Debug, Clone)]
struct CliModelsCacheEntry {
    models: Vec<String>,
    reason: Option<String>,
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
struct CodexRuntimeReadiness {
    runtime_ready: bool,
    readiness_reason: Option<String>,
    readiness_source: String,
    host_auth_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CliExecutionIsolationMode {
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

fn validate_agent_plan_content(plan: &AgentPlan) -> Result<(), String> {
    let has_content = !plan.architecture.trim().is_empty()
        || has_non_empty_items(&plan.stack)
        || plan
            .phases
            .iter()
            .any(phase_contains_non_empty_content)
        || has_non_empty_items(&plan.tradeoffs)
        || has_non_empty_items(&plan.warnings);

    if has_content {
        Ok(())
    } else {
        Err("JSON valid but empty plan payload. Ensure CLI returns at least one non-empty field.".to_string())
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
                let plan = parse_json_payload::<AgentPlan>(&raw)?;
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
        "{system}\n\nAgent label: {}\nRequirement original:\n{requirement}\n\nRéponds strictement en JSON valide.",
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
        "{system}\n\nAgent label: {}\nRequirement original: {requirement}\n\nClarifications du client:\n{clarifications}\n\nRéponds strictement en JSON valide.",
        agent.label
    )
}

pub async fn analyze_multi_via_cli(
    requirement: &str,
    phase_agents: &[ResolvedPhaseAgent],
    runtime_config: Option<&RuntimeConfigInput>,
) -> Result<Vec<NamedAgentResponse>, String> {
    let mut outputs = Vec::with_capacity(phase_agents.len());

    for (index, agent) in phase_agents.iter().enumerate() {
        let prompt = analysis_prompt_for_agent(agent, index, requirement);
        let label = format!("{} CLI phase1 analysis", agent.label);
        let raw = run_agent_cli(
            &agent.cli,
            Some(agent.id.as_str()),
            &prompt,
            ".",
            None,
            &label,
            runtime_config,
            CliExecutionIsolationMode::StrictPhase12,
        )
        .await?;
        let response = parse_json_payload::<AgentResponse>(&raw)
            .map_err(|err| format!("{label} JSON invalid: {err}"))?;
        validate_agent_response_content(&response).map_err(|err| {
            format!(
                "{label} {err}. Raw output snippet: {}",
                truncate(raw.trim(), 400)
            )
        })?;

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
) -> Result<Vec<NamedAgentPlan>, String> {
    let mut outputs = Vec::with_capacity(phase_agents.len());

    for (index, agent) in phase_agents.iter().enumerate() {
        let prompt = plan_prompt_for_agent(agent, index, requirement, clarifications);
        let label = format!("{} CLI phase2 planning", agent.label);
        let raw = run_agent_cli(
            &agent.cli,
            Some(agent.id.as_str()),
            &prompt,
            ".",
            None,
            &label,
            runtime_config,
            CliExecutionIsolationMode::StrictPhase12,
        )
        .await?;
        let plan = parse_json_payload::<AgentPlan>(&raw)
            .map_err(|err| format!("{label} JSON invalid: {err}"))?;
        validate_agent_plan_content(&plan).map_err(|err| format!("{label} {err}"))?;

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
) -> Result<String, String> {
    let prompt = format!(
        "{AGENT_A_CLI_PROMPT}\n\nRequirement:\n{requirement}\n\nClarifications:\n{clarifications}\n\nHuman decision:\n{decision}\n"
    );
    let raw = run_agent_cli(
        agent_a_cli,
        Some("phase3_agent_a"),
        &prompt,
        worktree_path,
        Some(worktree_path),
        "Agent A CLI generation",
        runtime_config,
        CliExecutionIsolationMode::SharedWorktree,
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
        let codex_readiness = if agent.cli == "codex" {
            Some(determine_codex_runtime_readiness())
        } else {
            None
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
            runtime_ready: codex_readiness
                .as_ref()
                .map(|readiness| readiness.runtime_ready)
                .unwrap_or(true),
            readiness_reason: codex_readiness
                .as_ref()
                .and_then(|readiness| readiness.readiness_reason.clone()),
            readiness_source: codex_readiness
                .as_ref()
                .map(|readiness| readiness.readiness_source.clone())
                .unwrap_or_else(|| "none".to_string()),
            requires_auth: agent.cli == "codex",
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
                format!(
                    "{primary_err}. Retry with isolated OpenCode config failed: {fallback_err}"
                )
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
    let cache_key = cli_models_cache_key(
        alias.as_str(),
        command_resolution.command.as_str(),
        command_resolution.source.as_str(),
    );

    if !force_refresh {
        if let Some(cached) = read_cli_models_cache(cache_key.as_str()) {
            let age_seconds = (Utc::now() - cached.updated_at).num_seconds();
            if age_seconds >= 0 && age_seconds <= CLI_MODELS_CACHE_FRESH_SECS {
                return Ok(CliModelsListOutput {
                    models: cached.models,
                    source: "cache".to_string(),
                    reason: cached.reason,
                    stale: false,
                    last_updated_at: Some(cached.updated_at.to_rfc3339()),
                });
            }

            if age_seconds >= 0 && age_seconds <= CLI_MODELS_CACHE_HARD_SECS {
                spawn_cli_models_background_refresh(
                    alias.clone(),
                    runtime_config.cloned(),
                    cache_key.clone(),
                );
                return Ok(CliModelsListOutput {
                    models: cached.models,
                    source: "cache".to_string(),
                    reason: cached.reason,
                    stale: true,
                    last_updated_at: Some(cached.updated_at.to_rfc3339()),
                });
            }
        }
    }

    let fetched =
        fetch_cli_models_live_or_fallback(alias.as_str(), runtime_config, force_refresh).await;
    let updated_at = Utc::now();
    write_cli_models_cache(
        cache_key.as_str(),
        CliModelsCacheEntry {
            models: fetched.models.clone(),
            reason: fetched.reason.clone(),
            updated_at,
        },
    );

    Ok(CliModelsListOutput {
        models: fetched.models,
        source: fetched.source,
        reason: fetched.reason,
        stale: false,
        last_updated_at: Some(updated_at.to_rfc3339()),
    })
}

fn cli_models_cache_key(alias: &str, command: &str, command_source: &str) -> String {
    format!("{alias}|{command_source}|{command}")
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
        let refreshed = fetch_cli_models_live_or_fallback(alias.as_str(), runtime_config.as_ref(), false).await;
        let updated_at = Utc::now();
        write_cli_models_cache(
            cache_key.as_str(),
            CliModelsCacheEntry {
                models: refreshed.models,
                reason: refreshed.reason,
                updated_at,
            },
        );
        clear_cli_models_refresh_inflight(cache_key.as_str());
    });
}

async fn fetch_cli_models_live_or_fallback(
    alias: &str,
    runtime_config: Option<&RuntimeConfigInput>,
    force_refresh: bool,
) -> CliModelsFetchResult {
    let fallback_models = default_models_for_cli(alias);

    if alias == "opencode" {
        return match list_opencode_models_with_refresh(runtime_config, force_refresh).await {
            Ok(models) if !models.is_empty() => CliModelsFetchResult {
                models,
                source: "live".to_string(),
                reason: None,
            },
            Ok(_) => CliModelsFetchResult {
                models: fallback_models,
                source: "fallback".to_string(),
                reason: Some("OpenCode live model listing returned no models.".to_string()),
            },
            Err(err) => CliModelsFetchResult {
                models: fallback_models,
                source: "fallback".to_string(),
                reason: Some(format!("OpenCode live model listing failed: {err}")),
            },
        };
    }

    let command_resolution = match resolve_cli_command(alias, runtime_config) {
        Ok(value) => value,
        Err(err) => {
            return CliModelsFetchResult {
                models: fallback_models,
                source: "fallback".to_string(),
                reason: Some(err),
            };
        }
    };
    let resolved_binary_path = resolve_binary_path(command_resolution.command.as_str());
    if resolved_binary_path.is_none() {
        return CliModelsFetchResult {
            models: fallback_models,
            source: "fallback".to_string(),
            reason: Some(format!(
                "Resolved command '{}' ({}) is not available in PATH.",
                command_resolution.command, command_resolution.source
            )),
        };
    }

    let live_result = match alias {
        "codex" => {
            let api_key = env_non_empty("OPENAI_API_KEY");
            match api_key {
                Some(api_key) => fetch_openai_models_from_api(api_key.as_str()).await,
                None => Err(
                    "OPENAI_API_KEY is missing; live Codex model listing via OpenAI API is unavailable."
                        .to_string(),
                ),
            }
        }
        "claude" => {
            let api_key = env_non_empty("ANTHROPIC_API_KEY");
            match api_key {
                Some(api_key) => fetch_anthropic_models_from_api(api_key.as_str()).await,
                None => Err(
                    "ANTHROPIC_API_KEY is missing; live Claude model listing via Anthropic API is unavailable."
                        .to_string(),
                ),
            }
        }
        "gemini" => {
            let api_key = env_non_empty("GEMINI_API_KEY");
            match api_key {
                Some(api_key) => fetch_gemini_models_from_api(api_key.as_str()).await,
                None => Err(
                    "GEMINI_API_KEY is missing; live Gemini model listing via Google API is unavailable."
                        .to_string(),
                ),
            }
        }
        _ => Err(format!(
            "Unsupported CLI '{}' for live model inventory.",
            cli_label(alias)
        )),
    };

    match live_result {
        Ok(models) if !models.is_empty() => CliModelsFetchResult {
            models,
            source: "live".to_string(),
            reason: None,
        },
        Ok(_) => CliModelsFetchResult {
            models: fallback_models,
            source: "fallback".to_string(),
            reason: Some(format!(
                "{} live model inventory returned no models.",
                cli_label(alias)
            )),
        },
        Err(err) => CliModelsFetchResult {
            models: fallback_models,
            source: "fallback".to_string(),
            reason: Some(format!("{} live model inventory failed: {err}", cli_label(alias))),
        },
    }
}

fn env_non_empty(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn model_inventory_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(CLI_MODELS_HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|err| format!("failed to initialize model inventory HTTP client: {err}"))
}

async fn fetch_openai_models_from_api(api_key: &str) -> Result<Vec<String>, String> {
    let client = model_inventory_http_client()?;
    let response = client
        .get("https://api.openai.com/v1/models")
        .header(AUTHORIZATION, format!("Bearer {api_key}"))
        .send()
        .await
        .map_err(|err| format!("OpenAI models request failed: {err}"))?;
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|err| format!("OpenAI models JSON decode failed: {err}"))?;
    if !status.is_success() {
        return Err(format!("OpenAI models request failed ({status}): {payload}"));
    }
    let models = payload
        .get("data")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(Value::as_str))
                .map(str::trim)
                .filter(|value| is_codex_or_openai_model_id(value))
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(dedupe_sort_models(models))
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
        return Err(format!("Google models request failed ({status}): {payload}"));
    }
    let models = payload
        .get("models")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
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
        "gemini" => vec![
            "gemini-2.5-pro".to_string(),
            "gemini-2.5-flash".to_string(),
        ],
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
) -> Result<(Vec<AttackReportItem>, String), String> {
    let prompt = format!(
        "{AGENT_B_ATTACK_PROMPT}\n\nRequirement:\n{requirement}\n\nCode under test (Agent A):\n{code_a}\n"
    );
    let raw = run_agent_cli(
        reviewer_cli,
        Some("phase3_agent_b"),
        &prompt,
        worktree_path,
        Some(worktree_path),
        "Agent B CLI attack analysis",
        runtime_config,
        CliExecutionIsolationMode::SharedWorktree,
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

async fn run_agent_cli(
    agent_cli: &str,
    agent_model_scope: Option<&str>,
    prompt: &str,
    workdir: &str,
    capture_base_dir: Option<&str>,
    label: &str,
    runtime_config: Option<&RuntimeConfigInput>,
    isolation_mode: CliExecutionIsolationMode,
) -> Result<String, String> {
    let mut capture_path: Option<PathBuf> = None;
    let mut extra_environment: Vec<(String, String)> = Vec::new();
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
            (
                command,
                {
                    let mut args = vec![
                        "exec".to_string(),
                        "--skip-git-repo-check".to_string(),
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
                },
            )
        }
        "gemini" => {
            let mut args = vec!["-p".to_string(), prompt.to_string()];
            if let Some(model) = model_resolution.model.as_ref() {
                args.push("--model".to_string());
                args.push(model.clone());
            }
            args.push("-o".to_string());
            args.push("text".to_string());
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
            (
                command,
                args,
            )
        }
        unsupported => {
            return Err(format!(
                "Unsupported CLI '{unsupported}'. Use claude|codex|gemini|opencode."
            ));
        }
    };

    let output = run_cli_command(
        &command,
        &args,
        &execution_context,
        label,
        agent_cli,
        &command_source,
        resolved_binary_path.as_deref(),
        &extra_environment,
    )
    .await?;

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

    if raw.trim().is_empty() {
        let path_hint = resolved_binary_path
            .as_deref()
            .map(|path| format!(", path='{path}'"))
            .unwrap_or_default();
        return Err(format!(
            "{label} selected CLI '{agent_cli}' resolved to command '{command}' ({command_source}{path_hint}) returned empty output"
        ));
    }

    Ok(raw)
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
                if let Ok(rel) = opencode_config.parent().unwrap_or(&opencode_config).strip_prefix(h_home) {
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
                    if t.is_empty() { None } else { Some(t.to_string()) }
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
        Some(chunks.join("\n"))
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

async fn run_cli_command(
    command: &str,
    args: &[String],
    execution_context: &CliExecutionContext,
    label: &str,
    selected_cli: &str,
    command_source: &str,
    resolved_binary_path: Option<&str>,
    extra_environment: &[(String, String)],
) -> Result<CliExecutionResult, String> {
    let timeout = Duration::from_secs(cli_timeout_secs());
    let path_hint = resolved_binary_path
        .map(|path| format!(", path='{path}'"))
        .unwrap_or_default();

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

    let output = tokio::time::timeout(timeout, cmd.output())
        .await
        .map_err(|_| format!("{label} timed out after {} seconds", timeout.as_secs()))?
        .map_err(|err| {
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

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        let code = output.status.code().unwrap_or(-1);
        let detail = if stderr.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            stderr.trim().to_string()
        };
        return Err(format!(
            "{label} selected CLI '{selected_cli}' resolved to command '{command}' ({command_source}{path_hint}) failed with exit code {code}: {detail}"
        ));
    }

    Ok(CliExecutionResult { stdout, stderr })
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
    
    // Repair missing closing quotes before array closures (common Llama3.2 error)
    out = out.replace(" :],", " :\"],");
    out = out.replace(" :]}", " :\"]}");
    out = out.replace(":[", "\": [");
    out
}

fn parse_json_payload<T: for<'de> Deserialize<'de>>(raw: &str) -> Result<T, String> {
    let sanitized_raw = sanitize_json_escapes(raw);
    
    let extracted = extract_json(&sanitized_raw).unwrap_or_else(|| sanitized_raw.trim().to_string());

    // Because some local LLMs or agent loops output multiple JSON objects (JSON Lines) or tool use objects before the final answer,
    // we iterate over all JSON objects in the string and keep the last valid one.
    let stream = serde_json::Deserializer::from_str(&extracted).into_iter::<serde_json::Value>();
    let mut last_valid_value: Option<serde_json::Value> = None;
    
    for value_result in stream {
        if let Ok(val) = value_result {
            last_valid_value = Some(val);
        }
    }
    
    let mut parsed = last_valid_value.ok_or_else(|| {
        let mut raw_snippet = extracted.clone();
        if raw_snippet.len() > 800 {
            raw_snippet.truncate(800);
            raw_snippet.push_str("...");
        }
        format!("Failed to locate any valid JSON object. Raw: {raw_snippet}")
    })?;

    // Fallback: If the model wrapped the response in a tool call format (e.g. {"name": "...", "parameters": {...}})
    if let Some(obj) = parsed.as_object_mut() {
        if obj.contains_key("name") && obj.contains_key("parameters") {
            if let Some(parameters) = obj.remove("parameters") {
                parsed = parameters.clone();
            }
        }
    }

    serde_json::from_value::<T>(parsed.clone()).map_err(|e| {
        let mut raw_snippet = parsed.to_string();
        if raw_snippet.len() > 800 {
            raw_snippet.truncate(800);
            raw_snippet.push_str("...");
        }
        format!("Failed to parse model JSON: {e}. Raw: {raw_snippet}")
    })
}

fn extract_json(raw: &str) -> Option<String> {
    let trimmed = raw.trim();

    if trimmed.starts_with("```") {
        let without_prefix = trimmed
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim();
        let without_suffix = without_prefix.trim_end_matches("```").trim();
        if without_suffix.starts_with('{') && without_suffix.ends_with('}') {
            return Some(without_suffix.to_string());
        }
    }

    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;

    if end <= start {
        return None;
    }

    Some(trimmed[start..=end].to_string())
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
