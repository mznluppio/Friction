use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

pub mod store;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AgentResponse {
    pub interpretation: String,
    pub assumptions: Vec<String>,
    pub risks: Vec<String>,
    pub questions: Vec<String>,
    pub approach: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PlanPhase {
    pub name: String,
    pub duration: String,
    pub tasks: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AgentPlan {
    pub stack: Vec<String>,
    pub phases: Vec<PlanPhase>,
    pub architecture: String,
    pub tradeoffs: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Divergence {
    pub field: String,
    pub unique_a: Option<Vec<String>>,
    pub unique_b: Option<Vec<String>>,
    pub a: Option<String>,
    pub b: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub consensus_text: Option<String>,
    #[serde(default)]
    pub consensus_items: Option<Vec<String>>,
    #[serde(default)]
    pub agent_values: Option<Vec<DivergenceAgentValue>>,
    #[serde(default)]
    pub outlier_agent_ids: Option<Vec<String>>,
    #[serde(default)]
    pub disagreement_score: Option<f32>,
    pub severity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DivergenceAgentValue {
    pub agent_id: String,
    pub label: String,
    pub kind: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub items: Option<Vec<String>>,
    pub distance: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedAgentResponse {
    pub id: String,
    pub label: String,
    pub cli: String,
    pub response: AgentResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedAgentPlan {
    pub id: String,
    pub label: String,
    pub cli: String,
    pub plan: AgentPlan,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Phase1Output {
    pub architect: AgentResponse,
    pub pragmatist: AgentResponse,
    #[serde(default)]
    pub agent_responses: Vec<NamedAgentResponse>,
    pub divergences: Vec<Divergence>,
    pub human_clarifications: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Phase2Output {
    pub architect: AgentPlan,
    pub pragmatist: AgentPlan,
    #[serde(default)]
    pub agent_plans: Vec<NamedAgentPlan>,
    pub divergences: Vec<Divergence>,
    pub human_decision: String,
    #[serde(default)]
    pub human_decision_structured: Option<HumanDecisionStructured>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Phase3Output {
    pub code_a: String,
    pub code_b: String,
    pub git_diff: String,
    pub attack_report: Vec<AttackReportItem>,
    pub confidence_score: f32,
    pub session_id: String,
    pub agent_a_branch: String,
    pub agent_b_branch: String,
    #[serde(default)]
    pub adr_path: Option<String>,
    #[serde(default)]
    pub adr_markdown: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttackReportItem {
    pub severity: String,
    pub title: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRecord {
    pub id: Uuid,
    pub requirement: String,
    pub agents: Vec<String>,
    pub phase1: Phase1Log,
    pub phase2: Phase2Log,
    pub phase3: Phase3Log,
    pub metadata: SessionMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Phase1Log {
    pub interpretations: Vec<AgentResponse>,
    pub divergences: Vec<Divergence>,
    pub human_clarifications: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Phase2Log {
    pub plans: Vec<AgentPlan>,
    pub divergences: Vec<Divergence>,
    pub human_decision: String,
    #[serde(default)]
    pub human_decision_structured: Option<HumanDecisionStructured>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanDecisionStructured {
    pub mode: String,
    #[serde(default)]
    pub winner_agent_id: Option<String>,
    #[serde(default)]
    pub hybrid: Option<HumanDecisionHybrid>,
    pub scorecard: Vec<HumanDecisionScoreRow>,
    pub rationale: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanDecisionHybrid {
    pub base_agent_id: String,
    #[serde(default)]
    pub stack: Option<String>,
    #[serde(default)]
    pub architecture: Option<String>,
    #[serde(default)]
    pub phases: Option<String>,
    #[serde(default)]
    pub warnings: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanDecisionScoreRow {
    pub agent_id: String,
    pub label: String,
    pub scores: HashMap<String, i32>,
    pub total: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Phase3Log {
    pub code_a: String,
    pub code_b: String,
    pub attack_report: Vec<AttackReportItem>,
    pub confidence_score: f32,
    #[serde(default)]
    pub adr_path: Option<String>,
    #[serde(default)]
    pub adr_markdown: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMetadata {
    pub timestamp: DateTime<Utc>,
    pub domain: String,
    pub complexity: String,
    pub consented_to_dataset: bool,
    #[serde(default)]
    pub schema_version: Option<String>,
    #[serde(default)]
    pub app_version: Option<String>,
    #[serde(default)]
    pub workflow_mode: Option<String>,
    #[serde(default)]
    pub runtime: Option<RuntimeMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeMetadata {
    pub prompt_bundle_version: String,
    #[serde(default)]
    pub agent_a_cli: Option<String>,
    #[serde(default)]
    pub agent_b_cli: Option<String>,
    #[serde(default)]
    pub phase_agents: Option<Vec<RuntimePhaseAgentMetadata>>,
    #[serde(default)]
    pub architect: Option<RuntimeAgentMetadata>,
    #[serde(default)]
    pub pragmatist: Option<RuntimeAgentMetadata>,
    pub judge: RuntimeJudgeMetadata,
    #[serde(default)]
    pub ollama_host: Option<String>,
    #[serde(default)]
    pub phase3_agent_a_cli: Option<String>,
    #[serde(default)]
    pub phase3_reviewer_cli: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeAgentMetadata {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeJudgeMetadata {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimePhaseAgentMetadata {
    pub id: String,
    pub label: String,
    pub cli: String,
}

impl SessionRecord {
    pub fn export_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }
}
