import { canUseTauriCommands, invokeCommand } from "./api";
import { inferComplexity, inferDomain } from "./agents/mock-agent";
import type {
  AttackReportItem,
  AgentCli,
  CliAliasModelInventory,
  CliModelInventorySource,
  CliResolutionDiagnostic,
  DatasetExportResult,
  FrictionSession,
  Phase12RuntimeDiagnostic,
  Phase1Result,
  Phase2Result,
  Phase3Result,
  Phase3RunInput,
  RuntimeSettings,
  SessionSummary
} from "./types";

const LOCAL_SESSIONS_KEY = "friction.sessions";
const SESSION_SCHEMA_VERSION = "friction.session.v1";
const WORKFLOW_MODE_CORE = "phase1-phase2-core-v1";
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

export function buildSessionExport(
  requirement: string,
  phase1: Phase1Result,
  phase2: Phase2Result,
  phase3: Phase3Result,
  consentedToDataset: boolean,
  runtimeSettings: RuntimeSettings,
  appVersion: string
): FrictionSession {
  const workflowMode = phase3.workflowMode ?? WORKFLOW_MODE_CORE;
  const phase1Interpretations =
    phase1.agentResponses && phase1.agentResponses.length >= 2
      ? phase1.agentResponses.map((item) => item.response)
      : [phase1.architect, phase1.pragmatist];
  const phase2Plans =
    phase2.agentPlans && phase2.agentPlans.length >= 2
      ? phase2.agentPlans.map((item) => item.plan)
      : [phase2.architect, phase2.pragmatist];

  return {
    id: crypto.randomUUID(),
    requirement,
    agents: runtimeSettings.phase12Agents.map((agent) => `${agent.label}:cli:${agent.cli}`),
    phase1: {
      interpretations: phase1Interpretations,
      divergences: phase1.divergences,
      human_clarifications: phase1.humanClarifications
    },
    phase2: {
      plans: phase2Plans,
      divergences: phase2.divergences,
      human_decision: phase2.humanDecision,
      human_decision_structured: phase2.humanDecisionStructured
    },
    phase3: {
      code_a: phase3.codeA,
      code_b: phase3.codeB,
      attack_report: phase3.attackReport,
      confidence_score: phase3.confidenceScore,
      adr_path: phase3.adrPath,
      adr_markdown: phase3.adrMarkdown
    },
    metadata: {
      timestamp: new Date().toISOString(),
      domain: inferDomain(requirement),
      complexity: inferComplexity(requirement),
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
        // Legacy fields kept for compatibility with older readers.
        phase3_agent_a_cli: runtimeSettings.phase3AgentACli,
        phase3_reviewer_cli: runtimeSettings.phase3AgentBCli
      }
    }
  };
}

export async function saveSessionRecord(session: FrictionSession): Promise<string> {
  if (canUseTauriCommands()) {
    return invokeCommand<string>("save_session", { record: session });
  }

  const sessions = readLocalSessions();
  const withoutCurrent = sessions.filter((item) => item.id !== session.id);
  withoutCurrent.push(session);
  localStorage.setItem(LOCAL_SESSIONS_KEY, JSON.stringify(withoutCurrent));
  return session.id;
}

export async function listSavedSessions(limit = 5): Promise<SessionSummary[]> {
  if (canUseTauriCommands()) {
    return invokeCommand<SessionSummary[]>("list_sessions", { limit });
  }

  return readLocalSessions()
    .sort((a, b) => b.metadata.timestamp.localeCompare(a.metadata.timestamp))
    .slice(0, limit)
    .map((session) => ({
      id: session.id,
      createdAt: session.metadata.timestamp,
      domain: session.metadata.domain,
      complexity: session.metadata.complexity,
      consentedToDataset: session.metadata.consented_to_dataset,
      requirementPreview: session.requirement.slice(0, 120)
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
    return invokeCommand<FrictionSession | null>("load_session", { id });
  }

  const sessions = readLocalSessions();
  return sessions.find((session) => session.id === id) ?? null;
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
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
