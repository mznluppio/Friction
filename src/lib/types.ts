export type AgentBias = "architect" | "pragmatist" | "security" | "custom";
export type LLMProvider = "mock" | "anthropic" | "openai" | "ollama";
export type AgentCli = "claude" | "codex" | "gemini" | "opencode";
export type AgentCliCommandMap = Partial<Record<AgentCli, string>>;
export type AgentCliModelMap = Partial<Record<AgentCli, string>>;
export type AgentCliModelPerAgentMap = Partial<Record<string, string>>;
export type CliModelInventorySource = "live" | "cache" | "fallback";

export interface CliAliasModelInventory {
  alias: AgentCli;
  models: string[];
  source: CliModelInventorySource;
  reason?: string;
  stale?: boolean;
  lastUpdatedAt?: string;
}

export type Domain = "auth" | "payment" | "notifications" | "analytics" | "other";
export type Complexity = "low" | "medium" | "high";

export interface AgentResponse {
  interpretation: string;
  assumptions: string[];
  risks: string[];
  questions: string[];
  approach: string;
}

export interface PlanPhase {
  name: string;
  duration: string;
  tasks: string[];
}

export interface AgentPlan {
  stack: string[];
  phases: PlanPhase[];
  architecture: string;
  tradeoffs: string[];
  warnings: string[];
}

export interface PhaseAgentRuntime {
  id: string;
  label: string;
  cli: AgentCli;
}

export interface PhaseAgentResponse {
  id: string;
  label: string;
  cli: AgentCli;
  response: AgentResponse;
}

export interface PhaseAgentPlan {
  id: string;
  label: string;
  cli: AgentCli;
  plan: AgentPlan;
}

export interface DivergenceAgentValue {
  agentId: string;
  label: string;
  kind: "text" | "list";
  text?: string;
  items?: string[];
  distance: number;
}

export interface Divergence {
  field: string;
  uniqueA?: string[];
  uniqueB?: string[];
  a?: string;
  b?: string;
  mode?: "pair" | "consensus";
  consensusText?: string;
  consensusItems?: string[];
  agentValues?: DivergenceAgentValue[];
  outlierAgentIds?: string[];
  disagreementScore?: number;
  severity: "low" | "medium" | "high";
}

export type ArbitrationCriterion =
  | "robustness"
  | "deliverySpeed"
  | "implementationCost"
  | "operationalComplexity";

export interface PlanScorecardRow {
  agentId: string;
  label: string;
  scores: Record<ArbitrationCriterion, number>;
  total: number;
}

export interface HybridSelection {
  baseAgentId: string;
  stack?: string;
  architecture?: string;
  phases?: string;
  warnings?: string;
}

export interface HumanDecisionStructured {
  mode: "winner" | "hybrid";
  winnerAgentId?: string;
  hybrid?: HybridSelection;
  scorecard: PlanScorecardRow[];
  rationale: string;
}

export interface Phase1Result {
  architect: AgentResponse;
  pragmatist: AgentResponse;
  agentResponses?: PhaseAgentResponse[];
  divergences: Divergence[];
  humanClarifications: string;
}

export interface Phase2Result {
  architect: AgentPlan;
  pragmatist: AgentPlan;
  agentPlans?: PhaseAgentPlan[];
  divergences: Divergence[];
  humanDecision: string;
  humanDecisionStructured?: HumanDecisionStructured;
}

export interface AttackReportItem {
  severity: "low" | "medium" | "high";
  title: string;
  detail: string;
}

export interface Phase3Result {
  codeA: string;
  codeB: string;
  gitDiff?: string;
  attackReport: AttackReportItem[];
  confidenceScore: number;
  sessionId?: string;
  agentABranch?: string;
  agentBBranch?: string;
  adrPath?: string;
  adrMarkdown?: string;
  workflowMode?: string;
}

export interface AgentRuntimeSettings {
  provider: LLMProvider;
  model: string;
}

export interface RuntimeSettings {
  phase12Agents: PhaseAgentRuntime[];
  phase3AgentACli: AgentCli;
  phase3AgentBCli: AgentCli;
  cliCommands?: AgentCliCommandMap;
  cliModels?: AgentCliModelMap;
  agentCliModels?: AgentCliModelPerAgentMap;
  judgeProvider: JudgeProvider;
  judgeModel: string;
  ollamaHost?: string;
  promptBundleVersion: string;
}

export interface CliResolutionDiagnostic {
  id: string;
  label: string;
  selectedCli: AgentCli;
  resolvedCommand: string;
  resolvedCommandSource: string;
  resolvedBinaryPath?: string;
  resolvedFamily: AgentCli | "unknown";
  resolvedModel?: string;
  resolvedModelSource?: string;
  runtimeReady?: boolean;
  readinessReason?: string;
  readinessSource?: "openai_api_key" | "codex_auth_file" | "none";
  requiresAuth?: boolean;
}

export interface Phase12RuntimeDiagnostic {
  agents: CliResolutionDiagnostic[];
}

export interface CliOnboardingStatus {
  cli: AgentCli;
  configuredCommand: string;
  resolvedCommand: string;
  source: string;
  resolvedPath: string;
  resolvedModel?: string;
  resolvedModelSource?: string;
  isExecutable: boolean;
  isReady: boolean;
  selectedMatches: boolean;
  detail: string;
}

export interface FrictionSession {
  id: string;
  requirement: string;
  agents: string[];
  phase1: {
    interpretations: AgentResponse[];
    divergences: Divergence[];
    human_clarifications: string;
  };
  phase2: {
    plans: AgentPlan[];
    divergences: Divergence[];
    human_decision: string;
    human_decision_structured?: HumanDecisionStructured;
  };
  phase3: {
    code_a: string;
    code_b: string;
    attack_report: AttackReportItem[];
    confidence_score: number;
    adr_path?: string;
    adr_markdown?: string;
  };
  metadata: {
    timestamp: string;
    domain: Domain;
    complexity: Complexity;
    consented_to_dataset: boolean;
    schema_version?: string;
    app_version?: string;
    workflow_mode?: string;
    runtime?: {
      prompt_bundle_version: string;
      agent_a_cli?: AgentCli;
      agent_b_cli?: AgentCli;
      phase_agents?: PhaseAgentRuntime[];
      cli_models?: AgentCliModelMap;
      agent_cli_models?: AgentCliModelPerAgentMap;
      judge: {
        provider: JudgeProvider;
        model: string;
      };
      ollama_host?: string;
      // Legacy fields (read compatibility only)
      architect?: AgentRuntimeSettings;
      pragmatist?: AgentRuntimeSettings;
      phase3_agent_a_cli?: AgentCli;
      phase3_reviewer_cli?: AgentCli;
    };
  };
}

export interface LLMAgent {
  name: string;
  bias: AgentBias;
  analyzeRequirement(requirement: string): Promise<AgentResponse>;
  buildPlan(requirement: string, clarifications: string): Promise<AgentPlan>;
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  domain: string;
  complexity: Complexity;
  consentedToDataset: boolean;
  requirementPreview: string;
}

export interface WorktreeLayout {
  mainBranch: string;
  sessionId: string;
  agentABranch: string;
  agentBBranch: string;
  agentAWorktree: string;
  agentBWorktree: string;
}

export interface DatasetExportResult {
  path: string;
  count: number;
}

export type JudgeProvider = "haiku" | "flash" | "ollama";

export interface Phase3RunInput {
  repoPath: string;
  baseBranch?: string;
  requirement: string;
  clarifications: string;
  decision: string;
  sessionId?: string;
  judgeProvider: JudgeProvider;
  judgeModel?: string;
  autoCleanup: boolean;
  runtimeSettings: RuntimeSettings;
}

export type AppPhase = 1 | 2 | 3;

export interface RouteState {
  phase: AppPhase;
  sessionId: string | null;
}

export type WorkflowStep =
  | "requirement"
  | "clarifications"
  | "decision"
  | "phase3_config"
  | "phase3_run"
  | "completed";

export interface ConversationMetaPayload {
  step: WorkflowStep;
  timestamp: string;
}

export interface ConversationPlanPayload {
  phase: 1 | 2;
  phase1?: Phase1Result;
  phase2?: Phase2Result;
  meta: ConversationMetaPayload;
}

export interface ConversationCodePayload {
  phase: 3;
  phase3: Phase3Result;
  repoPath: string;
  baseBranch: string;
  meta: ConversationMetaPayload;
}

export interface ConversationTaskPayload {
  title: string;
  description?: string;
  suggestions?: string[];
  done?: boolean;
  meta: ConversationMetaPayload;
}

export interface ConversationToolPayload {
  label: string;
  detail?: string;
  running?: boolean;
  meta: ConversationMetaPayload;
}

export interface ConversationErrorPayload {
  message: string;
  recoverable?: boolean;
  meta: ConversationMetaPayload;
}

export type ConversationPayload =
  | ConversationPlanPayload
  | ConversationCodePayload
  | ConversationTaskPayload
  | ConversationToolPayload
  | ConversationErrorPayload;

export type ConversationItem =
  | {
      id: string;
      type: "user" | "assistant";
      text: string;
      meta: ConversationMetaPayload;
    }
  | {
      id: string;
      type: "tool" | "status";
      payload: ConversationToolPayload;
    }
  | {
      id: string;
      type: "plan";
      payload: ConversationPlanPayload;
    }
  | {
      id: string;
      type: "code";
      payload: ConversationCodePayload;
    }
  | {
      id: string;
      type: "task";
      payload: ConversationTaskPayload;
    }
  | {
      id: string;
      type: "error";
      payload: ConversationErrorPayload;
    };

export interface UnsavedState {
  phase1Dirty: boolean;
  phase2Dirty: boolean;
  phase3Dirty: boolean;
}
