import { canUseTauriCommands, invokeCommand } from "./api";
import { inferComplexity, inferDomain } from "./agents/mock-agent";
import type {
  AttackReportItem,
  AgentCli,
  CliAliasModelInventory,
  CliModelInventorySource,
  CliResolutionDiagnostic,
  ConversationItem,
  DatasetExportResult,
  ExecutionBrief,
  FrictionInboxDraft,
  FrictionSession,
  Phase12RuntimeDiagnostic,
  Phase1Result,
  Phase2Result,
  Phase3Result,
  Phase3RunInput,
  SessionStatus,
  SessionWorkingState,
  RuntimeSettings,
  SessionSummary,
  WorkflowStep
} from "./types";

const LOCAL_SESSIONS_KEY = "friction.sessions";
const SESSION_SCHEMA_VERSION = "friction.session.v2";
const WORKFLOW_MODE_CORE = "problem-friction-brief-v2";
const WORKFLOW_MODE_PHASE3 = "phase3-adversarial-single-code-v1";

interface BackendPhase3Result {
  codeA: string;
  codeB: string;
  gitDiff: string;
  attackReport: AttackReportItem[];
  confidenceScore: number;
  sessionId: string;
  agentABranch: string;
  agentBBranch: string;
  adrPath?: string;
  adrMarkdown?: string;
}

interface BackendPhase12RuntimeDiagnostic {
  agents: CliResolutionDiagnostic[];
}

interface BackendOpencodeModelsOutput {
  models: string[];
}

interface BackendCliModelsOutput {
  models: string[];
  source: CliModelInventorySource;
  reason?: string;
  stale?: boolean;
  lastUpdatedAt?: string;
  providerMode?: string;
}

interface PhaseRunOptions {
  streamRequestId?: string;
}

export async function diagnosePhase12Cli(runtimeSettings: RuntimeSettings): Promise<Phase12RuntimeDiagnostic> {
  if (canUseTauriCommands()) {
    const phase12Agents = runtimeSettings.phase12Agents;
    return invokeCommand<BackendPhase12RuntimeDiagnostic>("diagnose_phase12_cli", {
      agent_a_cli: phase12Agents[0]?.cli,
      agent_b_cli: phase12Agents[1]?.cli,
      phase_agents: phase12Agents.map((agent) => ({
        id: agent.id,
        label: agent.label,
        cli: agent.cli
      })),
      runtime_config: {
        ollama_host: runtimeSettings.ollamaHost,
        cli_commands: runtimeSettings.cliCommands,
        cli_models: runtimeSettings.cliModels,
        agent_cli_models: runtimeSettings.agentCliModels
      }
    });
  }

  throw new Error("Tauri runtime requis. Lance l'application desktop pour diagnostiquer la runtime CLI.");
}

export async function runPhase1(
  requirement: string,
  runtimeSettings: RuntimeSettings,
  options?: PhaseRunOptions,
): Promise<Phase1Result> {
  if (canUseTauriCommands()) {
    const phase12Agents = runtimeSettings.phase12Agents;
    return invokeCommand<Phase1Result>("run_phase1", {
      requirement,
      agent_a_cli: phase12Agents[0]?.cli,
      agent_b_cli: phase12Agents[1]?.cli,
      phase_agents: phase12Agents.map((agent) => ({
        id: agent.id,
        label: agent.label,
        cli: agent.cli
      })),
      runtime_config: {
        ollama_host: runtimeSettings.ollamaHost,
        cli_commands: runtimeSettings.cliCommands,
        cli_models: runtimeSettings.cliModels,
        agent_cli_models: runtimeSettings.agentCliModels
      },
      stream_request_id: options?.streamRequestId
    });
  }

  throw new Error("Tauri runtime requis. Lance l'application desktop pour exécuter la phase 1.");
}

export async function runPhase2(
  requirement: string,
  clarifications: string,
  runtimeSettings: RuntimeSettings,
  options?: PhaseRunOptions,
): Promise<Phase2Result> {
  if (canUseTauriCommands()) {
    const phase12Agents = runtimeSettings.phase12Agents;
    return invokeCommand<Phase2Result>("run_phase2", {
      requirement,
      clarifications,
      agent_a_cli: phase12Agents[0]?.cli,
      agent_b_cli: phase12Agents[1]?.cli,
      phase_agents: phase12Agents.map((agent) => ({
        id: agent.id,
        label: agent.label,
        cli: agent.cli
      })),
      runtime_config: {
        ollama_host: runtimeSettings.ollamaHost,
        cli_commands: runtimeSettings.cliCommands,
        cli_models: runtimeSettings.cliModels,
        agent_cli_models: runtimeSettings.agentCliModels
      },
      stream_request_id: options?.streamRequestId
    });
  }

  throw new Error("Tauri runtime requis. Lance l'application desktop pour exécuter la phase 2.");
}

export async function runPhase3Adversarial(
  input: Phase3RunInput,
  options?: PhaseRunOptions,
): Promise<Phase3Result> {
  if (canUseTauriCommands()) {
    const payload = await invokeCommand<BackendPhase3Result>("run_phase3", {
      repo_path: input.repoPath,
      base_branch: input.baseBranch,
      requirement: input.requirement,
      clarifications: input.clarifications,
      decision: input.decision,
      session_id: input.sessionId,
      judge_provider: input.judgeProvider,
      judge_model: input.judgeModel,
      agent_a_cli: input.runtimeSettings.phase3AgentACli,
      agent_b_cli: input.runtimeSettings.phase3AgentBCli,
      runtime_config: {
        ollama_host: input.runtimeSettings.ollamaHost,
        cli_commands: input.runtimeSettings.cliCommands,
        cli_models: input.runtimeSettings.cliModels,
        agent_cli_models: input.runtimeSettings.agentCliModels
      },
      auto_cleanup: input.autoCleanup,
      stream_request_id: options?.streamRequestId
    });

    return {
      codeA: payload.codeA,
      codeB: payload.codeB,
      gitDiff: payload.gitDiff,
      attackReport: payload.attackReport,
      confidenceScore: payload.confidenceScore,
      sessionId: payload.sessionId,
      agentABranch: payload.agentABranch,
      agentBBranch: payload.agentBBranch,
      adrPath: payload.adrPath,
      adrMarkdown: payload.adrMarkdown,
      workflowMode: WORKFLOW_MODE_PHASE3
    };
  }

  throw new Error("Tauri runtime requis. Lance l'application desktop pour exécuter la phase 3.");
}

export async function runPhase3Preview(requirement: string): Promise<Phase3Result> {
  let backendDiff = "";

  if (canUseTauriCommands()) {
    try {
      backendDiff = await invokeCommand<string>("preview_diff", {});
    } catch {
      backendDiff = "";
    }
  }

  const lines = requirement
    .split(/\s+/)
    .filter((token) => token.length > 3)
    .slice(0, 6)
    .join("_")
    .toLowerCase();

  const codeA = `// Agent A (architect)\nexport async function execute_${lines || "feature"}() {\n  // TODO: implement isolated worktree execution\n  return { status: "ok", mode: "safe-first" };\n}`;

  const codeB =
    "// Agent B does not generate code in canonical adversarial mode.\n// Mission: attack the final code from Agent A.";

  const diffSignal = backendDiff.trim().length > 0 ? "Diff snapshot available from git layer." : "Diff engine is still stubbed in preview mode.";

  const attackReport: AttackReportItem[] = [
    {
      severity: "medium",
      title: "Input validation gap",
      detail: "La version fast-path ne valide pas encore les payloads hors schéma attendu."
    },
    {
      severity: "high",
      title: "Observability missing",
      detail: "Les deux branches ne propagent pas encore de trace-id corrélé session/agent."
    },
    {
      severity: "low",
      title: "Diff visibility",
      detail: diffSignal
    }
  ];

  return {
    codeA,
    codeB,
    gitDiff: backendDiff || "",
    attackReport,
    confidenceScore: backendDiff ? 0.78 : 0.74,
    workflowMode: WORKFLOW_MODE_PHASE3
  };
}

interface BuildSessionExportInput {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
  problemStatement: string;
  requirement?: string;
  workflowStep: WorkflowStep;
  composerText?: string;
  conversationItems?: ConversationItem[];
  frictionInboxDraft?: FrictionInboxDraft | null;
  proofMode?: SessionWorkingState["proofMode"];
  phase1?: Phase1Result | null;
  phase2?: Phase2Result | null;
  phase3?: Phase3Result | null;
  consentedToDataset: boolean;
  runtimeSettings: RuntimeSettings;
  appVersion: string;
  status?: SessionStatus;
}

function withTrimmed(value: string | undefined | null): string {
  return (value ?? "").trim();
}

function firstNonEmptyLine(value: string): string {
  return (
    value
      .split(/\r?\n/)
      .map((line) => withTrimmed(line))
      .find((line) => line.length > 0) ?? ""
  );
}

function truncate(value: string, max = 140): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

function normalizeLegacyPlan(plan: Partial<Phase2Result["architect"]> | undefined): Phase2Result["architect"] {
  const stack = Array.isArray(plan?.stack) ? plan.stack.filter(Boolean) : [];
  const phases = Array.isArray(plan?.phases) ? plan.phases : [];
  const architecture = withTrimmed(plan?.architecture);
  const tradeoffs = Array.isArray(plan?.tradeoffs) ? plan.tradeoffs.filter(Boolean) : [];
  const warnings = Array.isArray(plan?.warnings) ? plan.warnings.filter(Boolean) : [];
  const strategy = withTrimmed(plan?.strategy) || architecture || "No strategy captured.";
  const nextSteps =
    Array.isArray(plan?.nextSteps) && plan.nextSteps.length > 0
      ? plan.nextSteps.filter(Boolean)
      : phases.flatMap((phase) => phase.tasks.filter(Boolean));
  const risks =
    Array.isArray(plan?.risks) && plan.risks.length > 0
      ? plan.risks.filter(Boolean)
      : warnings;
  const legacyProblemRead = withTrimmed((plan as { problemRead?: string } | undefined)?.problemRead);
  const legacyMainHypothesis = withTrimmed(
    (plan as { mainHypothesis?: string } | undefined)?.mainHypothesis,
  );
  const openQuestions = Array.isArray(plan?.openQuestions)
    ? plan.openQuestions.filter(Boolean)
    : [];

  return {
    problemRead:
      legacyProblemRead ||
      (architecture
        ? `Frames the problem through this approach: ${architecture}`
        : "No explicit problem framing captured."),
    mainHypothesis:
      legacyMainHypothesis ||
      tradeoffs[0] ||
      risks[0] ||
      strategy,
    strategy,
    tradeoffs,
    nextSteps: nextSteps.slice(0, 6),
    risks,
    openQuestions,
    stack,
    phases,
    architecture,
    warnings,
  };
}

function normalizeExecutionBrief(
  brief: ExecutionBrief | undefined | null,
  fallbackProblemFrame: string,
): ExecutionBrief | undefined {
  if (!brief) return undefined;
  const legacySteps = Array.isArray((brief as { implementationSteps?: string[] }).implementationSteps)
    ? ((brief as { implementationSteps?: string[] }).implementationSteps ?? []).filter(Boolean)
    : [];
  const nextSteps = Array.isArray(brief.nextSteps) && brief.nextSteps.length > 0
    ? brief.nextSteps.filter(Boolean)
    : legacySteps;
  const openQuestions = Array.isArray(brief.openQuestions)
    ? brief.openQuestions.filter(Boolean)
    : [];

  return {
    ...brief,
    problemFrame: withTrimmed(brief.problemFrame) || fallbackProblemFrame || "No problem framing captured.",
    mainHypothesis:
      withTrimmed(brief.mainHypothesis) ||
      withTrimmed(brief.baselineApproach) ||
      "No main hypothesis captured.",
    acceptedTradeoffs: Array.isArray(brief.acceptedTradeoffs)
      ? brief.acceptedTradeoffs.filter(Boolean)
      : [],
    nextSteps,
    openRisks: Array.isArray(brief.openRisks) ? brief.openRisks.filter(Boolean) : [],
    openQuestions,
  };
}

function deriveSessionStatus(input: {
  workflowStep: WorkflowStep;
  phase1?: Phase1Result | null;
  phase2?: Phase2Result | null;
  phase3?: Phase3Result | null;
  composerText?: string;
  problemStatement: string;
}): SessionStatus {
  if (
    input.phase3 &&
    (withTrimmed(input.phase3.codeA) ||
      withTrimmed(input.phase3.codeB) ||
      input.phase3.attackReport.length > 0 ||
      input.phase3.confidenceScore > 0)
  ) {
    return "proof_ready";
  }
  if (input.workflowStep === "phase3_run") {
    return "proof_running";
  }
  if (input.phase2?.executionBrief || input.phase2?.actionBrief) {
    return "brief_ready";
  }
  if (input.phase1) {
    return "friction";
  }
  if (withTrimmed(input.problemStatement) || withTrimmed(input.composerText)) {
    return "draft";
  }
  return "draft";
}

function deriveSessionTitle(problemStatement: string, brief?: ExecutionBrief): string {
  const firstLine = firstNonEmptyLine(problemStatement);
  if (firstLine) return truncate(firstLine, 80);
  const decision = withTrimmed(brief?.finalDecision);
  if (decision) return truncate(decision, 80);
  return "Untitled draft";
}

function deriveProblemPreview(problemStatement: string, brief?: ExecutionBrief): string {
  const trimmedProblem = withTrimmed(problemStatement);
  if (trimmedProblem) return truncate(trimmedProblem, 140);
  const briefSummary = withTrimmed(brief?.problemFrame) || withTrimmed(brief?.finalDecision);
  if (briefSummary) return truncate(briefSummary, 140);
  return "";
}

export function normalizeSessionRecord(session: FrictionSession): FrictionSession {
  const problemStatement = withTrimmed(session.problem_statement) || withTrimmed(session.requirement);
  const normalizedPhase2 = session.phase2
    ? {
      ...session.phase2,
      plans: (session.phase2.plans ?? []).map((plan) => normalizeLegacyPlan(plan)),
    }
    : undefined;
  const brief =
    normalizeExecutionBrief(
      session.result?.action_brief ??
      session.result?.execution_brief ??
      normalizedPhase2?.action_brief ??
      normalizedPhase2?.execution_brief,
      problemStatement,
    ) ?? undefined;

  if (normalizedPhase2) {
    normalizedPhase2.execution_brief = brief ?? normalizedPhase2.execution_brief;
    normalizedPhase2.action_brief = brief ?? normalizedPhase2.action_brief;
  }

  return {
    ...session,
    title: withTrimmed(session.title) || deriveSessionTitle(problemStatement, brief),
    status:
      session.status ??
      deriveSessionStatus({
        workflowStep:
          session.working_state?.currentStep ?? (brief ? "brief" : session.phase1 ? "friction" : "requirement"),
        phase1:
          session.phase1 && session.phase1.interpretations.length >= 2
            ? {
              architect: session.phase1.interpretations[0],
              pragmatist: session.phase1.interpretations[1],
              divergences: session.phase1.divergences,
              humanClarifications: session.phase1.human_clarifications,
            }
            : null,
        phase2:
          normalizedPhase2 && normalizedPhase2.plans.length >= 2
            ? {
              architect: normalizedPhase2.plans[0],
              pragmatist: normalizedPhase2.plans[1],
              divergences: normalizedPhase2.divergences,
              humanDecision: normalizedPhase2.human_decision,
              humanDecisionStructured: normalizedPhase2.human_decision_structured,
              executionBrief: normalizedPhase2.execution_brief,
              actionBrief: normalizedPhase2.action_brief,
            }
            : null,
        phase3: session.phase3
          ? {
            codeA: session.phase3.code_a,
            codeB: session.phase3.code_b,
            attackReport: session.phase3.attack_report,
            confidenceScore: session.phase3.confidence_score,
            adrPath: session.phase3.adr_path,
            adrMarkdown: session.phase3.adr_markdown,
          }
          : null,
        problemStatement,
        composerText: session.working_state?.composerText,
      }),
    updated_at:
      withTrimmed(session.updated_at) || session.metadata.timestamp,
    problem_statement: problemStatement,
    requirement: problemStatement,
    conversation_items: Array.isArray(session.conversation_items)
      ? session.conversation_items
      : [],
    working_state: {
      composerText: session.working_state?.composerText ?? "",
      currentStep: session.working_state?.currentStep ?? (brief ? "brief" : session.phase1 ? "friction" : "requirement"),
      frictionDraft: session.working_state?.frictionDraft ?? null,
      proofMode: session.working_state?.proofMode ?? null,
    },
    phase2: normalizedPhase2,
    result: {
      action_brief: brief,
      execution_brief: brief,
    },
    metadata: {
      ...session.metadata,
      schema_version: session.metadata.schema_version ?? SESSION_SCHEMA_VERSION,
    },
  };
}

export function buildSessionExport({
  id,
  createdAt,
  updatedAt,
  problemStatement,
  requirement,
  workflowStep,
  composerText = "",
  conversationItems = [],
  frictionInboxDraft = null,
  proofMode = null,
  phase1 = null,
  phase2 = null,
  phase3 = null,
  consentedToDataset,
  runtimeSettings,
  appVersion,
  status,
}: BuildSessionExportInput): FrictionSession {
  const normalizedProblemStatement =
    withTrimmed(problemStatement) || withTrimmed(requirement);
  const normalizedPhase1 = phase1
    ? {
      interpretations:
        phase1.agentResponses && phase1.agentResponses.length >= 2
          ? phase1.agentResponses.map((item) => item.response)
          : [phase1.architect, phase1.pragmatist].filter(Boolean),
      divergences: phase1.divergences,
      human_clarifications: phase1.humanClarifications,
    }
    : undefined;
  const normalizedPhase2Plans = phase2
    ? (
      phase2.agentPlans && phase2.agentPlans.length >= 2
        ? phase2.agentPlans.map((item) => item.plan)
        : [phase2.architect, phase2.pragmatist]
    ).map((plan) => normalizeLegacyPlan(plan))
    : undefined;
  const normalizedBrief = normalizeExecutionBrief(
    phase2?.actionBrief ?? phase2?.executionBrief,
    normalizedProblemStatement,
  );
  const normalizedPhase2 = phase2
    ? {
      plans: normalizedPhase2Plans ?? [],
      divergences: phase2.divergences,
      human_decision: phase2.humanDecision,
      human_decision_structured: phase2.humanDecisionStructured,
      execution_brief: normalizedBrief,
      action_brief: normalizedBrief,
    }
    : undefined;
  const normalizedPhase3 = phase3
    ? {
      code_a: phase3.codeA,
      code_b: phase3.codeB,
      attack_report: phase3.attackReport,
      confidence_score: phase3.confidenceScore,
      adr_path: phase3.adrPath,
      adr_markdown: phase3.adrMarkdown,
    }
    : undefined;
  const effectiveStatus =
    status ??
    deriveSessionStatus({
      workflowStep,
      phase1,
      phase2,
      phase3,
      composerText,
      problemStatement: normalizedProblemStatement,
    });
  const workflowMode = phase3?.workflowMode ?? WORKFLOW_MODE_CORE;
  const safeCreatedAt = createdAt ?? new Date().toISOString();
  const safeUpdatedAt = updatedAt ?? new Date().toISOString();

  return normalizeSessionRecord({
    id: id ?? crypto.randomUUID(),
    title: deriveSessionTitle(normalizedProblemStatement, normalizedBrief),
    status: effectiveStatus,
    updated_at: safeUpdatedAt,
    problem_statement: normalizedProblemStatement,
    requirement: normalizedProblemStatement,
    agents: runtimeSettings.phase12Agents.map((agent) => `${agent.label}:cli:${agent.cli}`),
    conversation_items: conversationItems,
    working_state: {
      composerText,
      currentStep: workflowStep,
      frictionDraft: frictionInboxDraft,
      proofMode,
    },
    phase1: normalizedPhase1,
    phase2: normalizedPhase2,
    phase3: normalizedPhase3,
    result: {
      action_brief: normalizedBrief,
      execution_brief: normalizedBrief,
    },
    metadata: {
      timestamp: safeCreatedAt,
      domain: inferDomain(normalizedProblemStatement),
      complexity: inferComplexity(normalizedProblemStatement),
      consented_to_dataset: consentedToDataset,
      schema_version: SESSION_SCHEMA_VERSION,
      app_version: appVersion,
      workflow_mode: workflowMode,
      runtime: {
        prompt_bundle_version: runtimeSettings.promptBundleVersion,
        agent_a_cli: runtimeSettings.phase12Agents[0]?.cli,
        agent_b_cli: runtimeSettings.phase12Agents[1]?.cli,
        phase_agents: runtimeSettings.phase12Agents,
        cli_models: runtimeSettings.cliModels,
        agent_cli_models: runtimeSettings.agentCliModels,
        judge: {
          provider: runtimeSettings.judgeProvider,
          model: runtimeSettings.judgeModel
        },
        ollama_host: runtimeSettings.ollamaHost,
        phase3_agent_a_cli: runtimeSettings.phase3AgentACli,
        phase3_reviewer_cli: runtimeSettings.phase3AgentBCli
      }
    }
  });
}

export async function saveSessionRecord(session: FrictionSession): Promise<string> {
  const normalized = normalizeSessionRecord(session);
  if (canUseTauriCommands()) {
    return invokeCommand<string>("save_session", { record: normalized });
  }

  const sessions = readLocalSessions();
  const withoutCurrent = sessions.filter((item) => item.id !== normalized.id);
  withoutCurrent.push(normalized);
  localStorage.setItem(LOCAL_SESSIONS_KEY, JSON.stringify(withoutCurrent));
  return normalized.id;
}

export async function deleteSessionRecord(id: string): Promise<void> {
  if (canUseTauriCommands()) {
    return invokeCommand<void>("delete_session", { id });
  }

  const sessions = readLocalSessions();
  const withoutCurrent = sessions.filter((item) => item.id !== id);
  localStorage.setItem(LOCAL_SESSIONS_KEY, JSON.stringify(withoutCurrent));
}

export async function listSavedSessions(limit = 5): Promise<SessionSummary[]> {
  if (canUseTauriCommands()) {
    return invokeCommand<SessionSummary[]>("list_sessions", { limit });
  }

  return readLocalSessions()
    .sort((a, b) => {
      const left = withTrimmed(a.updated_at) || a.metadata.timestamp;
      const right = withTrimmed(b.updated_at) || b.metadata.timestamp;
      return right.localeCompare(left);
    })
    .slice(0, limit)
    .map((session) => ({
      id: session.id,
      createdAt: session.metadata.timestamp,
      updatedAt: withTrimmed(session.updated_at) || session.metadata.timestamp,
      status: session.status ?? "draft",
      title: withTrimmed(session.title) || deriveSessionTitle(session.problem_statement ?? session.requirement),
      domain: session.metadata.domain,
      complexity: session.metadata.complexity,
      consentedToDataset: session.metadata.consented_to_dataset,
      problemPreview:
        deriveProblemPreview(
          session.problem_statement ?? session.requirement,
          session.result?.action_brief ?? session.phase2?.action_brief ?? session.phase2?.execution_brief,
        )
    }));
}

export async function listOpencodeModels(runtimeSettings: RuntimeSettings): Promise<string[]> {
  if (canUseTauriCommands()) {
    const payload = await invokeCommand<BackendOpencodeModelsOutput>("list_opencode_models", {
      runtime_config: {
        ollama_host: runtimeSettings.ollamaHost,
        cli_commands: runtimeSettings.cliCommands,
        cli_models: runtimeSettings.cliModels,
        agent_cli_models: runtimeSettings.agentCliModels
      }
    });
    return payload.models;
  }

  throw new Error("Tauri runtime requis. Lance l'application desktop pour lister les modeles OpenCode.");
}

export async function listCliModels(
  cliAlias: AgentCli,
  runtimeSettings: RuntimeSettings,
  options?: {
    forceRefresh?: boolean;
  }
): Promise<CliAliasModelInventory> {
  const startedAt = performance.now();
  const fetchedAt = new Date().toISOString();
  if (canUseTauriCommands()) {
    const payload = await invokeCommand<BackendCliModelsOutput>("list_cli_models", {
      cli_alias: cliAlias,
      force_refresh: options?.forceRefresh ?? false,
      runtime_config: {
        ollama_host: runtimeSettings.ollamaHost,
        cli_commands: runtimeSettings.cliCommands,
        cli_models: runtimeSettings.cliModels,
        agent_cli_models: runtimeSettings.agentCliModels
      }
    });
    return {
      alias: cliAlias,
      models: payload.models,
      source: payload.source,
      reason: payload.reason,
      stale: payload.stale ?? false,
      lastUpdatedAt: payload.lastUpdatedAt ?? fetchedAt,
      providerMode: payload.providerMode,
      fetchDurationMs: Math.max(1, Math.round(performance.now() - startedAt)),
      fetchedAt,
    };
  }

  throw new Error("Tauri runtime requis. Lance l'application desktop pour lister les modeles CLI.");
}

export async function loadSessionRecord(id: string): Promise<FrictionSession | null> {
  if (canUseTauriCommands()) {
    const payload = await invokeCommand<FrictionSession | null>("load_session", { id });
    return payload ? normalizeSessionRecord(payload) : null;
  }

  const sessions = readLocalSessions();
  const session = sessions.find((entry) => entry.id === id) ?? null;
  return session ? normalizeSessionRecord(session) : null;
}

export async function exportConsentedDataset(
  targetPath?: string
): Promise<DatasetExportResult> {
  if (canUseTauriCommands()) {
    return invokeCommand<DatasetExportResult>("export_consented_dataset", {
      target_path: targetPath
    });
  }

  const consented = readLocalSessions().filter((session) => session.metadata.consented_to_dataset);
  const jsonl = consented.map((session) => JSON.stringify(session)).join("\n");
  const blob = new Blob([jsonl], { type: "application/jsonl" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `friction-dataset-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);

  return {
    path: "browser-download",
    count: consented.length
  };
}

function readLocalSessions(): FrictionSession[] {
  try {
    const raw = localStorage.getItem(LOCAL_SESSIONS_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw) as FrictionSession[];
    return Array.isArray(parsed) ? parsed.map((session) => normalizeSessionRecord(session)) : [];
  } catch {
    return [];
  }
}
