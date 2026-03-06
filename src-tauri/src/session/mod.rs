use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
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
    #[serde(rename = "problemRead", alias = "problem_read")]
    pub problem_read: String,
    #[serde(rename = "mainHypothesis", alias = "main_hypothesis")]
    pub main_hypothesis: String,
    pub strategy: String,
    #[serde(rename = "nextSteps", alias = "next_steps")]
    pub next_steps: Vec<String>,
    pub risks: Vec<String>,
    #[serde(rename = "openQuestions", alias = "open_questions")]
    pub open_questions: Vec<String>,
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
    #[serde(default)]
    pub execution_brief: Option<ExecutionBrief>,
    #[serde(default)]
    pub action_brief: Option<ExecutionBrief>,
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
    #[serde(default)]
    pub id: Uuid,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub problem_statement: Option<String>,
    #[serde(default)]
    pub requirement: String,
    #[serde(default)]
    pub agents: Vec<String>,
    #[serde(default)]
    pub conversation_items: Vec<Value>,
    #[serde(default)]
    pub working_state: Option<SessionWorkingState>,
    #[serde(default)]
    pub phase1: Option<Phase1Log>,
    #[serde(default)]
    pub phase2: Option<Phase2Log>,
    #[serde(default)]
    pub phase3: Option<Phase3Log>,
    #[serde(default)]
    pub result: Option<SessionResult>,
    #[serde(default)]
    pub metadata: SessionMetadata,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Phase1Log {
    pub interpretations: Vec<AgentResponse>,
    pub divergences: Vec<Divergence>,
    pub human_clarifications: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Phase2Log {
    pub plans: Vec<AgentPlan>,
    pub divergences: Vec<Divergence>,
    pub human_decision: String,
    #[serde(default)]
    pub human_decision_structured: Option<HumanDecisionStructured>,
    #[serde(default)]
    pub execution_brief: Option<ExecutionBrief>,
    #[serde(default)]
    pub action_brief: Option<ExecutionBrief>,
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RuntimeAgentMetadata {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RuntimeJudgeMetadata {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RuntimePhaseAgentMetadata {
    pub id: String,
    pub label: String,
    pub cli: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionBrief {
    pub mode: String,
    pub problem_frame: String,
    pub final_decision: String,
    pub baseline_agent_id: String,
    pub baseline_label: String,
    pub baseline_approach: String,
    pub main_hypothesis: String,
    pub accepted_tradeoffs: Vec<String>,
    pub constraints: String,
    pub next_steps: Vec<String>,
    pub open_risks: Vec<String>,
    pub open_questions: Vec<String>,
    #[serde(default)]
    pub merge_note: Option<String>,
    #[serde(default)]
    pub borrowed_agent_id: Option<String>,
    #[serde(default)]
    pub borrowed_label: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrictionResolutionDraft {
    pub key: String,
    pub field: String,
    pub severity: String,
    #[serde(default)]
    pub choice: Option<String>,
    #[serde(default)]
    pub rationale: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrictionInboxDraft {
    #[serde(default)]
    pub direction: Option<String>,
    #[serde(default)]
    pub context_note: String,
    #[serde(default)]
    pub resolutions: Vec<FrictionResolutionDraft>,
    #[serde(default)]
    pub status: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofModeWorkingState {
    pub open: bool,
    #[serde(default)]
    pub repo_path: String,
    #[serde(default)]
    pub base_branch: String,
    #[serde(default)]
    pub consented_to_dataset: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionWorkingState {
    #[serde(default)]
    pub composer_text: String,
    #[serde(default)]
    pub current_step: String,
    #[serde(default)]
    pub friction_draft: Option<FrictionInboxDraft>,
    #[serde(default)]
    pub proof_mode: Option<ProofModeWorkingState>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResult {
    #[serde(default)]
    pub action_brief: Option<ExecutionBrief>,
    #[serde(default)]
    pub execution_brief: Option<ExecutionBrief>,
}

impl SessionRecord {
    pub fn export_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }
}
