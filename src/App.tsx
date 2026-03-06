import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { Thread, ThreadList } from "@assistant-ui/react-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Download, PanelLeft, Save, Settings2 } from "lucide-react";
import { AgentCard } from "./components/AgentCard";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { DiffViewer } from "./components/DiffViewer";
import { DivergenceBlock } from "./components/DivergenceBlock";
import { PlanPanel } from "./components/PlanPanel";
import { SessionsDrawer } from "./components/SessionsDrawer";
import { SettingsDialog } from "./components/SettingsDialog";
import { OnboardingCliSetupScreen } from "./components/OnboardingCliSetupScreen";
import { ThemeProvider, ThemeToggle } from "./components/ThemeProvider";
import { CodeCard } from "./components/chat/CodeCard";
import { ConversationShell } from "./components/chat/ConversationShell";
import { CommandTimelineCard } from "./components/chat/CommandTimelineCard";
import { ExecutionBriefCard } from "./components/chat/ExecutionBriefCard";
import { FrictionPhase1Inline } from "./components/chat/FrictionPhase1Inline";
import { PlanCard } from "./components/chat/PlanCard";
import { AssistantMessageArtifactAware } from "./components/chat/AssistantMessageArtifactAware";
import { WorkflowPromptInput } from "./components/chat/prompt-input/WorkflowPromptInput";
import { SuggestionChips } from "./components/chat/SuggestionChips";
import { TaskRail } from "./components/chat/TaskRail";
import { Button } from "./components/ui/button";
import { canUseTauriCommands } from "./lib/api";
import {
  buildSessionExport,
  diagnosePhase12Cli,
  exportConsentedDataset,
  listCliModels,
  listSavedSessions,
  loadSessionRecord,
  runPhase1,
  runPhase2,
  runPhase3Adversarial,
  saveSessionRecord,
} from "./lib/orchestrator";
import {
  DEFAULT_ROUTE_STATE,
  applyRouteState,
  readRouteStateFromLocation,
} from "./lib/route-state";
import { downloadSession } from "./lib/session";
import { formatDateTime, formatPercent } from "./lib/formatters";
import type {
  AgentCli,
  CliAliasModelInventory,
  AgentCliCommandMap,
  AgentCliModelPerAgentMap,
  AgentCliModelMap,
  AppPhase,
  CliOnboardingStatus,
  CliResolutionDiagnostic,
  ConversationItem,
  ConversationMetaPayload,
  Divergence,
  ExecutionBrief,
  FrictionInboxDraft,
  FrictionResolutionChoice,
  FrictionSession,
  HumanDecisionStructured,
  JudgeProvider,
  CliCommandLogEvent,
  CliTimelineRun,
  Phase12RuntimeDiagnostic,
  PhaseAgentPlan,
  PhaseAgentResponse,
  PhaseAgentRuntime,
  Phase1Result,
  Phase2Result,
  Phase3Result,
  PlanScorecardRow,
  RouteState,
  RuntimeSettings,
  SessionStatus,
  SessionSummary,
  TopDisagreement,
  UnsavedState,
  WorkflowStep,
} from "./lib/types";

type ConfirmIntent = {
  title: string;
  description: string;
  confirmLabel: string;
};

const APP_VERSION = "1.0.2";
const PROMPT_BUNDLE_VERSION = "friction-prompts.2026-03-03";

import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";

const MarkdownText = (props: any) => (
  <MarkdownTextPrimitive {...props} remarkPlugins={[remarkGfm]} />
);

const SETTINGS_KEY = "friction.settings.v1";
const CLI_SETUP_KEY_V2 = "friction.cliSetup.v2.complete";
const CLI_SETUP_KEY_LEGACY_V1 = "friction.cliSetup.v1.complete";
const LEGACY_DRAFT_KEY = "friction.draft";
const AUTOSAVE_MIN_NON_WHITESPACE = 8;
const AUTOSAVE_DEBOUNCE_MS = 800;

const JUDGE_PROVIDER_OPTIONS: JudgeProvider[] = [
  "haiku",
  "flash",
  "ollama",
  "opencode",
];
const AGENT_CLI_OPTIONS: AgentCli[] = ["claude", "codex", "gemini", "opencode"];

const DEFAULT_JUDGE_PROVIDER: JudgeProvider = "haiku";
const DEFAULT_AGENT_A_CLI: AgentCli = "claude";
const DEFAULT_AGENT_B_CLI: AgentCli = "codex";
const MAX_PHASE_AGENTS = 4;

const PHASE_AGENT_PRESETS: {
  id: string;
  label: string;
  defaultCli: AgentCli;
  directionDescription: string;
}[] = [
    {
      id: "agent_a",
      label: "Agent A · Architect",
      defaultCli: DEFAULT_AGENT_A_CLI,
      directionDescription: "Robustness and long-term architecture.",
    },
    {
      id: "agent_b",
      label: "Agent B · Pragmatist",
      defaultCli: DEFAULT_AGENT_B_CLI,
      directionDescription: "Fastest practical delivery path.",
    },
    {
      id: "agent_c",
      label: "Agent C · Challenger",
      defaultCli: "gemini",
      directionDescription: "Independent critical perspective.",
    },
    {
      id: "agent_d",
      label: "Agent D · Operator",
      defaultCli: "claude",
      directionDescription: "Operations, reliability, and cost.",
    },
  ];

const CLI_DETECTION_PRIORITY: AgentCli[] = [
  "claude",
  "codex",
  "gemini",
  "opencode",
];
const CLI_DETECTION_AGENTS: PhaseAgentRuntime[] = [
  { id: "detect_claude", label: "Detect Claude", cli: "claude" },
  { id: "detect_codex", label: "Detect Codex", cli: "codex" },
  { id: "detect_gemini", label: "Detect Gemini", cli: "gemini" },
  { id: "detect_opencode", label: "Detect OpenCode", cli: "opencode" },
];

const CLI_COMMAND_LOG_EVENT_NAME = "friction://cli-command-log";
const STDERR_ANSI_PREFIX = "\u001b[31m[stderr]\u001b[0m ";
const CLI_TIMELINE_OUTPUT_MAX_CHARS = 1_000_000;
const CLI_TIMELINE_TRUNCATED_SUFFIX = "\n...[truncated]\n";
const CLI_TIMELINE_EVENT_FLUSH_MS = 75;
const CLI_TIMELINE_EVENT_IMMEDIATE_FLUSH_THRESHOLD = 12;
const THREAD_ARTIFACT_MARKER_PREFIX = "FRICTION_ARTIFACT::";
const THREAD_SCROLL_BOTTOM_VISIBILITY_THRESHOLD_PX = 80;

const SUGGESTION_SETS: Record<WorkflowStep, string[]> = {
  requirement: [],
  friction: [],
  brief: [
    "Create snapshot",
    "Export session",
    "Export consented dataset",
    "New session",
  ],
  phase3_run: [],
};

const PROMPT_HINTS: Record<WorkflowStep, string> = {
  requirement: "Describe the bug, decision, hypothesis, or open problem…",
  friction:
    "Resolve the top 3 disagreements in the inline card. Add one context note only if needed…",
  brief:
    "Action brief ready — export it or open proof mode if you need repo evidence.",
  phase3_run: "Proof mode running…",
};

function withTrimmed(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function nonWhitespaceLength(value: string): number {
  return value.replace(/\s+/g, "").length;
}

function buildDefaultPhaseAgents(count = 2): PhaseAgentRuntime[] {
  return PHASE_AGENT_PRESETS.slice(
    0,
    Math.max(2, Math.min(MAX_PHASE_AGENTS, count)),
  ).map((preset) => ({
    id: preset.id,
    label: preset.label,
    cli: preset.defaultCli,
  }));
}

function normalizePhaseAgents(raw: unknown): PhaseAgentRuntime[] {
  if (!Array.isArray(raw)) {
    return buildDefaultPhaseAgents(2);
  }

  const normalized = raw
    .map((item, index): PhaseAgentRuntime | null => {
      if (!item || typeof item !== "object") return null;
      const source = item as Record<string, unknown>;
      const preset = PHASE_AGENT_PRESETS[index];
      if (!preset) return null;
      return {
        id:
          typeof source.id === "string" && source.id.trim()
            ? source.id
            : preset.id,
        label:
          typeof source.label === "string" && source.label.trim()
            ? source.label
            : preset.label,
        cli: ensureAgentCli(
          typeof source.cli === "string" ? source.cli : undefined,
          preset.defaultCli,
        ),
      };
    })
    .filter((item): item is PhaseAgentRuntime => item !== null)
    .slice(0, MAX_PHASE_AGENTS);

  if (normalized.length < 2) {
    return buildDefaultPhaseAgents(2);
  }

  return normalized;
}

function ensureAtLeastTwoPhaseAgents(
  value: PhaseAgentRuntime[],
): PhaseAgentRuntime[] {
  if (value.length >= 2) return value.slice(0, MAX_PHASE_AGENTS);

  const defaults = buildDefaultPhaseAgents(2);
  return defaults.map((fallback, index) => value[index] ?? fallback);
}

function uniqueCliAliases(aliases: AgentCli[]): AgentCli[] {
  const seen = new Set<AgentCli>();
  const ordered: AgentCli[] = [];
  aliases.forEach((alias) => {
    if (seen.has(alias)) return;
    seen.add(alias);
    ordered.push(alias);
  });
  return ordered;
}

function phase12AgentsFromRuntime(
  runtime: FrictionSession["metadata"]["runtime"] | undefined,
): PhaseAgentRuntime[] {
  if (!runtime) return buildDefaultPhaseAgents(2);

  if (runtime.phase_agents && runtime.phase_agents.length >= 2) {
    return ensureAtLeastTwoPhaseAgents(
      normalizePhaseAgents(runtime.phase_agents),
    );
  }

  const defaults = buildDefaultPhaseAgents(2);
  defaults[0].cli = ensureAgentCli(
    runtime.agent_a_cli ?? runtime.phase3_agent_a_cli,
    defaults[0].cli,
  );
  defaults[1].cli = ensureAgentCli(
    runtime.agent_b_cli ?? runtime.phase3_reviewer_cli,
    defaults[1].cli,
  );
  return defaults;
}

function phase3CliFromRuntime(
  runtime: FrictionSession["metadata"]["runtime"] | undefined,
  phase12Agents: PhaseAgentRuntime[],
): { agentA: AgentCli; agentB: AgentCli } {
  const safePhase12 = ensureAtLeastTwoPhaseAgents(phase12Agents);
  return {
    agentA: ensureAgentCli(runtime?.phase3_agent_a_cli, safePhase12[0].cli),
    agentB: ensureAgentCli(runtime?.phase3_reviewer_cli, safePhase12[1].cli),
  };
}

function phase1AgentsFromResult(
  result: Phase1Result | null,
  phaseAgents: PhaseAgentRuntime[],
): PhaseAgentResponse[] {
  if (!result) return [];
  if (result.agentResponses && result.agentResponses.length >= 2) {
    return result.agentResponses.map((item, index) => ({
      id: item.id,
      label: item.label,
      cli: ensureAgentCli(
        item.cli,
        phaseAgents[index]?.cli ?? DEFAULT_AGENT_A_CLI,
      ),
      response: item.response,
    }));
  }

  const safeAgents = ensureAtLeastTwoPhaseAgents(phaseAgents);
  return [
    {
      id: safeAgents[0].id,
      label: safeAgents[0].label,
      cli: safeAgents[0].cli,
      response: result.architect,
    },
    {
      id: safeAgents[1].id,
      label: safeAgents[1].label,
      cli: safeAgents[1].cli,
      response: result.pragmatist,
    },
  ];
}

function phase2AgentsFromResult(
  result: Phase2Result | null,
  phaseAgents: PhaseAgentRuntime[],
): PhaseAgentPlan[] {
  if (!result) return [];
  if (result.agentPlans && result.agentPlans.length >= 2) {
    return result.agentPlans.map((item, index) => ({
      id: item.id,
      label: item.label,
      cli: ensureAgentCli(
        item.cli,
        phaseAgents[index]?.cli ?? DEFAULT_AGENT_A_CLI,
      ),
      plan: item.plan,
    }));
  }

  const safeAgents = ensureAtLeastTwoPhaseAgents(phaseAgents);
  return [
    {
      id: safeAgents[0].id,
      label: safeAgents[0].label,
      cli: safeAgents[0].cli,
      plan: result.architect,
    },
    {
      id: safeAgents[1].id,
      label: safeAgents[1].label,
      cli: safeAgents[1].cli,
      plan: result.pragmatist,
    },
  ];
}

function frictionResolutionKey(divergence: Divergence, index: number): string {
  return `${divergence.field}:${index}`;
}

function severityWeight(severity: Divergence["severity"]): number {
  if (severity === "high") return 0;
  if (severity === "medium") return 1;
  return 2;
}

function deriveTopDisagreements(
  result: Phase1Result | null,
): TopDisagreement[] {
  if (!result) return [];

  return result.divergences
    .map((divergence, index) => ({
      key: frictionResolutionKey(divergence, index),
      index,
      field: divergence.field,
      severity: divergence.severity,
      disagreementScore: divergence.disagreementScore,
      divergence,
    }))
    .sort((left, right) => {
      const severityDelta =
        severityWeight(left.severity) - severityWeight(right.severity);
      if (severityDelta !== 0) return severityDelta;

      const scoreDelta =
        (right.disagreementScore ?? Number.NEGATIVE_INFINITY) -
        (left.disagreementScore ?? Number.NEGATIVE_INFINITY);
      if (scoreDelta !== 0) return scoreDelta;

      return left.index - right.index;
    })
    .slice(0, 3)
    .map((item, rank) => ({
      ...item,
      rank,
    }));
}

function normalizeFrictionRationale(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeFrictionChoice(
  value: unknown,
): FrictionResolutionChoice | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const normalized = trimmed.toLowerCase();
  if (normalized === "hybrid") return "hybrid";
  if (normalized === "a" || normalized === "agent_a") return "agent:agent_a";
  if (normalized === "b" || normalized === "agent_b") return "agent:agent_b";
  if (normalized.startsWith("agent:")) {
    const agentId = withTrimmed(trimmed.slice("agent:".length));
    if (!agentId) return undefined;
    return `agent:${agentId}`;
  }
  return undefined;
}

function frictionChoiceAgentId(
  choice?: FrictionResolutionChoice,
): string | null {
  if (!choice || choice === "hybrid") return null;
  if (!choice.startsWith("agent:")) return null;
  const agentId = withTrimmed(choice.slice("agent:".length));
  return agentId || null;
}

function normalizeFrictionInboxDraft(
  draft: FrictionInboxDraft,
): FrictionInboxDraft {
  return {
    ...draft,
    direction: normalizeFrictionChoice(draft.direction),
    contextNote: typeof draft.contextNote === "string" ? draft.contextNote : "",
    resolutions: draft.resolutions.map((item) => ({
      ...item,
      choice: normalizeFrictionChoice(item.choice),
    })),
  };
}

function createFrictionInboxDraft(result: Phase1Result): FrictionInboxDraft {
  const topDisagreements = deriveTopDisagreements(result);
  return {
    status: topDisagreements.length === 0 ? "ready" : "draft",
    contextNote: "",
    resolutions: topDisagreements.map((item) => ({
      key: item.key,
      field: item.field,
      severity: item.severity,
      rationale: "",
    })),
  };
}

function reconcileFrictionInboxDraft(
  result: Phase1Result,
  draft: FrictionInboxDraft | null | undefined,
): FrictionInboxDraft {
  const topDisagreements = deriveTopDisagreements(result);
  const normalizedDraft = draft ? normalizeFrictionInboxDraft(draft) : null;
  const resolutions = topDisagreements.map((item) => {
    const previous = normalizedDraft?.resolutions.find(
      (entry) => entry.key === item.key,
    );
    return {
      key: item.key,
      field: item.field,
      severity: item.severity,
      choice: previous?.choice,
      rationale: previous?.rationale ?? "",
    };
  });

  const nextDraft: FrictionInboxDraft = {
    direction: normalizedDraft?.direction,
    contextNote: normalizedDraft?.contextNote ?? "",
    resolutions,
    status: topDisagreements.length === 0 ? "ready" : "draft",
  };

  nextDraft.status = computeFrictionGateState(result, nextDraft).ready
    ? "ready"
    : "draft";
  return nextDraft;
}

function computeFrictionGateState(
  result: Phase1Result | null,
  draft: FrictionInboxDraft | null,
): { ready: boolean; invalidKeys: string[] } {
  if (!result || !draft) return { ready: false, invalidKeys: [] };

  const invalidKeys = deriveTopDisagreements(result)
    .map((item) => item.key)
    .filter((key) => {
      const entry = draft.resolutions.find((item) => item.key === key);
      return !entry?.choice;
    });

  return {
    ready:
      deriveTopDisagreements(result).length === 0 || invalidKeys.length === 0,
    invalidKeys,
  };
}

function frictionChoiceLabel(
  choice: FrictionResolutionChoice,
  phase1Agents: PhaseAgentResponse[],
): string {
  if (choice === "hybrid") return "Hybrid";
  const agentId = frictionChoiceAgentId(choice);
  if (!agentId) return "Hybrid";
  const agent = phase1Agents.find((item) => item.id === agentId);
  return agent?.label ?? `Agent ${agentId}`;
}

function buildClarificationsFromFrictionInbox(
  result: Phase1Result,
  draft: FrictionInboxDraft,
  phase1Agents: PhaseAgentResponse[],
): string {
  const topDisagreements = deriveTopDisagreements(result);
  const lines: string[] = [];
  const normalizedDirection = normalizeFrictionChoice(draft.direction);

  if (normalizedDirection) {
    lines.push(
      `Direction override: ${frictionChoiceLabel(normalizedDirection, phase1Agents)}`,
    );
    lines.push("");
  }

  lines.push("Top disagreements:");

  if (topDisagreements.length === 0) {
    lines.push("- No disagreement selected.");
  } else {
    topDisagreements.forEach((item, index) => {
      const key = item.key;
      const entry = draft.resolutions.find(
        (resolution) => resolution.key === key,
      );
      const choice = normalizeFrictionChoice(entry?.choice) ?? "hybrid";
      lines.push(
        `${index + 1}. [${item.field}] -> ${frictionChoiceLabel(choice, phase1Agents)}`,
      );
      const note = normalizeFrictionRationale(entry?.rationale ?? "");
      if (note) lines.push(`Note: ${note}`);
    });
  }

  lines.push("");
  lines.push("Context note:");
  lines.push(withTrimmed(draft.contextNote) || "none provided");
  return lines.join("\n");
}

function buildNeutralScorecard(plans: PhaseAgentPlan[]): PlanScorecardRow[] {
  return plans.map((plan) => ({
    agentId: plan.id,
    label: plan.label,
    scores: {
      robustness: 3,
      deliverySpeed: 3,
      implementationCost: 3,
      operationalComplexity: 3,
    },
    total: 12,
  }));
}

function findPhase2Plan(
  plans: PhaseAgentPlan[],
  agentId: string | null | undefined,
): PhaseAgentPlan | null {
  if (!agentId) return plans[0] ?? null;
  return plans.find((plan) => plan.id === agentId) ?? plans[0] ?? null;
}

function collectNextSteps(plan: PhaseAgentPlan | null): string[] {
  if (!plan) return [];
  if (plan.plan.nextSteps.length > 0) {
    return plan.plan.nextSteps.slice(0, 3);
  }

  const directTasks = plan.plan.phases.flatMap((phase) => phase.tasks);
  if (directTasks.length > 0) return directTasks.slice(0, 3);

  return plan.plan.phases
    .slice(0, 3)
    .map((phase) =>
      withTrimmed(phase.duration)
        ? `${phase.name} (${phase.duration})`
        : phase.name,
    );
}

function summarizeBaselineApproach(plan: PhaseAgentPlan | null): string {
  if (!plan) return "No baseline approach captured.";

  const strategy = withTrimmed(plan.plan.strategy);
  const problemRead = withTrimmed(plan.plan.problemRead);
  if (strategy && problemRead) {
    return `${problemRead} Strategy: ${strategy}`;
  }
  if (strategy) return strategy;
  if (problemRead) return problemRead;
  const architecture = withTrimmed(plan.plan.architecture);
  if (architecture) return architecture;
  return "No baseline approach captured.";
}

function buildHumanDecisionStructuredFromBrief(
  brief: ExecutionBrief,
  plans: PhaseAgentPlan[],
): HumanDecisionStructured {
  return brief.mode === "winner"
    ? {
      mode: "winner",
      winnerAgentId: brief.baselineAgentId,
      scorecard: buildNeutralScorecard(plans),
      rationale: brief.finalDecision,
    }
    : {
      mode: "hybrid",
      hybrid: {
        baseAgentId: brief.baselineAgentId,
      },
      scorecard: buildNeutralScorecard(plans),
      rationale: brief.mergeNote ?? brief.finalDecision,
    };
}

function buildDecisionFromBrief(brief: ExecutionBrief): string {
  const lines = [
    `Decision mode: ${brief.mode}`,
    `Problem frame: ${brief.problemFrame}`,
    `Final decision: ${brief.finalDecision}`,
    `Baseline: ${brief.baselineLabel}`,
    `Main hypothesis: ${brief.mainHypothesis}`,
    `Constraints: ${brief.constraints}`,
    "",
    "Accepted tradeoffs:",
    ...fallbackList(
      brief.acceptedTradeoffs,
      "No explicit tradeoff captured.",
    ).map((item) => `- ${item}`),
    "",
    "Next steps:",
    ...fallbackList(brief.nextSteps, "No next step captured.").map(
      (item) => `- ${item}`,
    ),
    "",
    "Open risks:",
    ...fallbackList(brief.openRisks, "No explicit open risk captured.").map(
      (item) => `- ${item}`,
    ),
    "",
    "Open questions:",
    ...fallbackList(brief.openQuestions, "No open question captured.").map(
      (item) => `- ${item}`,
    ),
  ];

  if (brief.mergeNote) {
    lines.push("", `Merge note: ${brief.mergeNote}`);
  }

  return lines.join("\n");
}

function fallbackList(items: string[], fallback: string): string[] {
  return items.length > 0 ? items : [fallback];
}

function synthesizeExecutionBrief(
  plans: PhaseAgentPlan[],
  draft: FrictionInboxDraft,
  topDisagreements: TopDisagreement[],
): ExecutionBrief {
  const selectedChoices = topDisagreements
    .map((item) => {
      const entry = draft.resolutions.find(
        (resolution) => resolution.key === item.key,
      );
      return normalizeFrictionChoice(entry?.choice);
    })
    .filter((choice): choice is FrictionResolutionChoice => Boolean(choice));
  const overrideAgentId = frictionChoiceAgentId(
    normalizeFrictionChoice(draft.direction),
  );
  const explicitAgentVotes = selectedChoices.filter(
    (choice) => choice !== "hybrid",
  );
  const allChoicesAlignToOneAgent =
    selectedChoices.length > 0 &&
    selectedChoices.every((choice) => {
      const agentId = frictionChoiceAgentId(choice);
      return (
        Boolean(agentId) &&
        agentId === frictionChoiceAgentId(selectedChoices[0])
      );
    });
  const overrideUncontested =
    Boolean(overrideAgentId) &&
    selectedChoices.every((choice) => {
      const agentId = frictionChoiceAgentId(choice);
      return !agentId || agentId === overrideAgentId;
    });

  const mode: ExecutionBrief["mode"] =
    allChoicesAlignToOneAgent || overrideUncontested ? "winner" : "hybrid";

  let baselineAgentId: string | null = null;
  if (mode === "winner") {
    baselineAgentId =
      overrideAgentId ??
      frictionChoiceAgentId(selectedChoices[0]) ??
      plans[0]?.id ??
      null;
  } else if (overrideAgentId) {
    baselineAgentId = overrideAgentId;
  } else {
    const voteCount = new Map<string, number>();
    explicitAgentVotes.forEach((choice) => {
      const agentId = frictionChoiceAgentId(choice);
      if (!agentId) return;
      voteCount.set(agentId, (voteCount.get(agentId) ?? 0) + 1);
    });

    let majorityAgentId: string | null = null;
    let majorityVotes = 0;
    let hasTie = false;
    voteCount.forEach((count, agentId) => {
      if (count > majorityVotes) {
        majorityAgentId = agentId;
        majorityVotes = count;
        hasTie = false;
        return;
      }
      if (count === majorityVotes) {
        hasTie = true;
      }
    });

    baselineAgentId =
      majorityAgentId && !hasTie ? majorityAgentId : (plans[0]?.id ?? null);
  }

  const baselinePlan = findPhase2Plan(plans, baselineAgentId);
  const borrowedPlan =
    plans.find((plan) => plan.id !== baselinePlan?.id) ?? null;
  const constraints = withTrimmed(draft.contextNote) || "none provided";
  const acceptedTradeoffs = fallbackList(
    baselinePlan?.plan.tradeoffs.slice(0, 2) ?? [],
    "No explicit tradeoff captured.",
  );
  const nextSteps = fallbackList(
    collectNextSteps(baselinePlan),
    "No next step captured.",
  );
  const openRisks = fallbackList(
    baselinePlan?.plan.risks.slice(0, 2) ??
    baselinePlan?.plan.warnings.slice(0, 2) ??
    [],
    "No explicit open risk captured.",
  );
  const openQuestions = fallbackList(
    baselinePlan?.plan.openQuestions.slice(0, 2) ?? [],
    "No open question captured.",
  );
  const baselineLabel = baselinePlan?.label ?? "Unknown baseline";
  const borrowedLabel = borrowedPlan?.label;
  const baselineApproach = summarizeBaselineApproach(baselinePlan);
  const problemFrame =
    withTrimmed(baselinePlan?.plan.problemRead) ||
    baselineApproach ||
    "No problem framing captured.";
  const mainHypothesis =
    withTrimmed(baselinePlan?.plan.mainHypothesis) ||
    baselineApproach ||
    "No main hypothesis captured.";
  const mergeNote =
    mode === "hybrid" && borrowedLabel
      ? `Keep ${baselineLabel} as the primary direction. Borrow only the strongest perspective from ${borrowedLabel} without reopening the whole problem.`
      : undefined;

  const finalDecision =
    mode === "winner"
      ? `Keep ${baselineLabel} as the primary direction.`
      : borrowedLabel
        ? `Use ${baselineLabel} as the base and borrow a focused perspective from ${borrowedLabel}.`
        : `Use ${baselineLabel} as the base and keep the merge surface minimal.`;

  return {
    mode,
    problemFrame,
    finalDecision,
    baselineAgentId:
      baselinePlan?.id ?? baselineAgentId ?? plans[0]?.id ?? "agent_a",
    baselineLabel,
    baselineApproach,
    mainHypothesis,
    acceptedTradeoffs,
    constraints,
    nextSteps,
    openRisks,
    openQuestions,
    mergeNote,
    borrowedAgentId: borrowedPlan?.id,
    borrowedLabel,
  };
}

function synthesizeExecutionBriefFromLegacyDecision(
  phase2: Phase2Result,
  plans: PhaseAgentPlan[],
  constraints: string,
): ExecutionBrief {
  const structured = phase2.humanDecisionStructured;
  const mode = structured?.mode ?? "winner";
  const baselineAgentId =
    structured?.mode === "hybrid"
      ? structured.hybrid?.baseAgentId
      : structured?.winnerAgentId;
  const baselinePlan = findPhase2Plan(plans, baselineAgentId);
  const borrowedPlan =
    plans.find((plan) => plan.id !== baselinePlan?.id) ?? null;
  const baselineLabel = baselinePlan?.label ?? "Unknown baseline";
  const fallbackDecision =
    mode === "hybrid" && borrowedPlan
      ? `Use ${baselineLabel} as the base and borrow a focused perspective from ${borrowedPlan.label}.`
      : `Keep ${baselineLabel} as the implementation baseline.`;
  const humanDecision = withTrimmed(phase2.humanDecision);

  return {
    mode,
    problemFrame:
      withTrimmed(baselinePlan?.plan.problemRead) ||
      summarizeBaselineApproach(baselinePlan),
    finalDecision: humanDecision
      ? firstSentence(humanDecision)
      : fallbackDecision,
    baselineAgentId: baselinePlan?.id ?? plans[0]?.id ?? "agent_a",
    baselineLabel,
    baselineApproach: summarizeBaselineApproach(baselinePlan),
    mainHypothesis:
      withTrimmed(baselinePlan?.plan.mainHypothesis) ||
      summarizeBaselineApproach(baselinePlan),
    acceptedTradeoffs: fallbackList(
      baselinePlan?.plan.tradeoffs.slice(0, 2) ?? [],
      "No explicit tradeoff captured.",
    ),
    constraints: withTrimmed(constraints) || "none provided",
    nextSteps: fallbackList(
      collectNextSteps(baselinePlan),
      "No next step captured.",
    ),
    openRisks: fallbackList(
      baselinePlan?.plan.risks.slice(0, 2) ??
      baselinePlan?.plan.warnings.slice(0, 2) ??
      [],
      "No explicit open risk captured.",
    ),
    openQuestions: fallbackList(
      baselinePlan?.plan.openQuestions.slice(0, 2) ?? [],
      "No open question captured.",
    ),
    mergeNote:
      mode === "hybrid" && borrowedPlan
        ? `Keep ${baselineLabel} as the primary direction. Borrow only the strongest perspective from ${borrowedPlan.label} without reopening the whole problem.`
        : undefined,
    borrowedAgentId: borrowedPlan?.id,
    borrowedLabel: borrowedPlan?.label,
  };
}

/** Truncate to the first sentence (or first 160 chars). */
function firstSentence(text: string): string {
  const dot = text.search(/\.\s/);
  if (dot > 0 && dot < 200) return text.slice(0, dot + 1);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/** Build the assistant message shown after Phase 1 completes. */
function buildPhase1CompletionMessage(
  result: Phase1Result,
  phase1Agents: PhaseAgentResponse[],
): string {
  const frictionCount = result.divergences.length;
  const topDisagreements = deriveTopDisagreements(result);
  const lines: string[] = [];

  lines.push(
    frictionCount === 0
      ? "Phase 1 complete — agents aligned on the problem statement."
      : `Phase 1 complete — ${frictionCount} friction point${frictionCount > 1 ? "s" : ""} detected.`,
  );

  // Core tension: pull from the approach divergence (most actionable signal)
  const approachDiv = result.divergences.find((d) => d.field === "approach");
  const leadA = phase1Agents[0];
  const leadB = phase1Agents[1];
  const aApproach = (approachDiv?.a ?? leadA?.response.approach ?? "").trim();
  const bApproach = (approachDiv?.b ?? leadB?.response.approach ?? "").trim();

  if (aApproach || bApproach) {
    lines.push("");
    lines.push("Core tension:");
    if (aApproach)
      lines.push(
        `• ${leadA?.label ?? "Agent A"} → ${firstSentence(aApproach)}`,
      );
    if (bApproach)
      lines.push(
        `• ${leadB?.label ?? "Agent B"} → ${firstSentence(bApproach)}`,
      );
  } else if (
    approachDiv?.consensusText ||
    approachDiv?.outlierAgentIds?.length
  ) {
    lines.push("");
    lines.push("Core tension:");
    if (approachDiv.consensusText) {
      lines.push(
        `• Consensus baseline → ${firstSentence(approachDiv.consensusText)}`,
      );
    }
    if (approachDiv.outlierAgentIds?.length) {
      const labelMap = new Map(
        phase1Agents.map((agent) => [agent.id, agent.label]),
      );
      lines.push(
        `• Outliers → ${approachDiv.outlierAgentIds
          .map((id) => labelMap.get(id) ?? id)
          .join(", ")}`,
      );
    }
  }

  lines.push("");
  lines.push(
    topDisagreements.length > 0
      ? `Next step: resolve the top ${topDisagreements.length} disagreement${topDisagreements.length > 1 ? "s" : ""} in the inline card below.`
      : "Next step: review the aligned interpretation, then generate the action brief.",
  );
  lines.push(
    "Add one context note only if something important is missing, then generate the brief.",
  );

  if (phase1Agents.length > 2) {
    lines.push(
      `Extra perspectives active: ${phase1Agents
        .slice(2)
        .map((item) => item.label)
        .join(", ")}`,
    );
  }

  return lines.join("\n");
}

function buildExecutionBriefReadyMessage(brief: ExecutionBrief): string {
  const lines = [
    "Action brief ready.",
    "",
    `Problem frame: ${brief.problemFrame}`,
    `Decision: ${brief.finalDecision}`,
    `Main hypothesis: ${brief.mainHypothesis}`,
    `Baseline: ${brief.baselineLabel}`,
    `Constraints: ${brief.constraints}`,
  ];

  if (brief.mergeNote) {
    lines.push(`Merge note: ${brief.mergeNote}`);
  }

  return lines.join("\n");
}

function phaseFromStep(step: WorkflowStep): AppPhase {
  if (step === "requirement" || step === "friction") return 1;
  if (step === "brief") return 2;
  return 3;
}

function stepFromPhase(phase: AppPhase): WorkflowStep {
  if (phase === 1) return "requirement";
  return "brief";
}

function normalizeWorkflowStep(value: string | undefined): WorkflowStep {
  if (value === "requirement" || value === "friction" || value === "brief") {
    return value;
  }
  if (value === "phase3_run") return "brief";
  if (value === "clarifications") return "friction";
  if (
    value === "decision" ||
    value === "phase3_config" ||
    value === "completed"
  ) {
    return "brief";
  }
  return "requirement";
}

function placeholderPhase3(): Phase3Result {
  return {
    codeA: "",
    codeB: "",
    gitDiff: "",
    attackReport: [],
    confidenceScore: 0,
  };
}

function ensureJudgeProvider(value: string | undefined): JudgeProvider {
  // "mock" may appear in older sessions; default to the cheap current provider.
  if (value === "mock") return DEFAULT_JUDGE_PROVIDER;
  return (JUDGE_PROVIDER_OPTIONS.find((item) => item === value) ??
    DEFAULT_JUDGE_PROVIDER) as JudgeProvider;
}

function ensureAgentCli(
  value: string | undefined,
  fallback: AgentCli,
): AgentCli {
  return (AGENT_CLI_OPTIONS.find((item) => item === value) ??
    fallback) as AgentCli;
}

function normalizeCliCommands(raw: unknown): AgentCliCommandMap {
  if (!raw || typeof raw !== "object") return {};

  const source = raw as Record<string, unknown>;
  const output: AgentCliCommandMap = {};
  AGENT_CLI_OPTIONS.forEach((cli) => {
    const value = source[cli];
    if (typeof value === "string" && value.trim().length > 0) {
      output[cli] = value.trim();
    }
  });
  return output;
}

function normalizeCliModels(raw: unknown): AgentCliModelMap {
  if (!raw || typeof raw !== "object") return {};

  const source = raw as Record<string, unknown>;
  const output: AgentCliModelMap = {};
  AGENT_CLI_OPTIONS.forEach((cli) => {
    const value = source[cli];
    if (typeof value === "string" && value.trim().length > 0) {
      output[cli] = value.trim();
    }
  });
  return output;
}

function normalizeAgentCliModels(raw: unknown): AgentCliModelPerAgentMap {
  if (!raw || typeof raw !== "object") return {};

  const source = raw as Record<string, unknown>;
  const output: AgentCliModelPerAgentMap = {};
  Object.entries(source).forEach(([key, value]) => {
    if (typeof key !== "string" || !key.trim()) return;
    if (typeof value !== "string" || !value.trim()) return;
    output[key.trim()] = value.trim();
  });
  return output;
}

function metaFor(step: WorkflowStep): ConversationMetaPayload {
  return {
    step,
    timestamp: new Date().toISOString(),
  };
}

function makeInitialConversation(): ConversationItem[] {
  return [
    {
      id: crypto.randomUUID(),
      type: "assistant",
      text: "Describe the problem statement. I will run phase 1 automatically after you send.",
      meta: metaFor("requirement"),
    },
  ];
}

function extractThreadTextContent(content: unknown): string {
  if (typeof content === "string") {
    return withTrimmed(content);
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const fragments: string[] = [];
  content.forEach((part) => {
    if (!part || typeof part !== "object") return;
    const maybePart = part as { type?: unknown; text?: unknown };
    if (
      maybePart.type === "text" &&
      typeof maybePart.text === "string" &&
      maybePart.text.trim()
    ) {
      fragments.push(maybePart.text.trim());
    }
  });
  return withTrimmed(fragments.join("\n"));
}

function isArtifactConversationItem(item: ConversationItem): boolean {
  if (
    item.type === "task" ||
    item.type === "plan" ||
    item.type === "code" ||
    item.type === "cli_timeline" ||
    item.type === "friction_phase1" ||
    item.type === "friction_inbox" ||
    item.type === "execution_brief" ||
    item.type === "decision_phase2" ||
    item.type === "validate_phase3" ||
    item.type === "workflow_done"
  ) {
    return true;
  }
  return false;
}

function toThreadArtifactMarker(itemId: string): string {
  return `${THREAD_ARTIFACT_MARKER_PREFIX}${itemId}`;
}

function parseThreadArtifactMarker(content: string): string | null {
  const trimmed = withTrimmed(content);
  if (!trimmed || !trimmed.startsWith(THREAD_ARTIFACT_MARKER_PREFIX)) {
    return null;
  }
  const marker = withTrimmed(
    trimmed.slice(THREAD_ARTIFACT_MARKER_PREFIX.length),
  );
  if (!marker) return null;
  const versionDelimiterIndex = marker.indexOf("::v");
  if (versionDelimiterIndex <= 0) {
    return marker;
  }
  return withTrimmed(marker.slice(0, versionDelimiterIndex)) || null;
}

function conversationItemToAssistantThreadMessage(
  item: ConversationItem,
  artifactRefreshTokens?: Map<string, string>,
): { id: string; role: "assistant" | "user"; content: string } | null {
  if (item.type === "user" || item.type === "assistant") {
    const text = withTrimmed(item.text);
    if (!text) return null;
    return {
      id: item.id,
      role: item.type,
      content: text,
    };
  }

  if (isArtifactConversationItem(item)) {
    const markerBase = toThreadArtifactMarker(item.id);
    const refreshToken = artifactRefreshTokens?.get(item.id);
    return {
      id: item.id,
      role: "assistant",
      content:
        refreshToken && withTrimmed(refreshToken)
          ? `${markerBase}::v${refreshToken}`
          : markerBase,
    };
  }

  if (item.type === "status" || item.type === "tool") {
    const title = withTrimmed(item.payload.label);
    const detail = withTrimmed(item.payload.detail ?? "");
    const content = detail ? `**${title}**\n${detail}` : `**${title}**`;
    return {
      id: item.id,
      role: "assistant",
      content,
    };
  }

  if (item.type === "error") {
    const message = withTrimmed(item.payload.message);
    if (!message) return null;
    return {
      id: item.id,
      role: "assistant",
      content: `ERROR\n${message}`,
    };
  }

  return null;
}

function isCliCommandLogEventPayload(
  value: unknown,
): value is CliCommandLogEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<CliCommandLogEvent>;
  if (typeof event.requestId !== "string" || !event.requestId.trim())
    return false;
  if (event.phase !== 1 && event.phase !== 2 && event.phase !== 3) return false;
  if (typeof event.kind !== "string" || !event.kind.trim()) return false;
  if (typeof event.timestamp !== "string" || !event.timestamp.trim())
    return false;
  return true;
}

function createCliTimelineRun(
  requestId: string,
  phase: 1 | 2 | 3,
  timestamp?: string,
): CliTimelineRun {
  const now =
    timestamp && timestamp.trim() ? timestamp : new Date().toISOString();
  return {
    requestId,
    phase,
    status: "running",
    createdAt: now,
    updatedAt: now,
    commands: [],
  };
}

function appendCliTimelineChunkWithCap(
  currentOutput: string,
  chunk: string,
  alreadyTruncated: boolean,
): { output: string; truncated: boolean } {
  if (alreadyTruncated) {
    return { output: currentOutput, truncated: true };
  }
  const remaining = CLI_TIMELINE_OUTPUT_MAX_CHARS - currentOutput.length;
  if (remaining <= 0) {
    const output = currentOutput.endsWith(CLI_TIMELINE_TRUNCATED_SUFFIX)
      ? currentOutput
      : `${currentOutput}${CLI_TIMELINE_TRUNCATED_SUFFIX}`;
    return { output, truncated: true };
  }
  if (chunk.length <= remaining) {
    return {
      output: `${currentOutput}${chunk}`,
      truncated: false,
    };
  }
  return {
    output: `${currentOutput}${chunk.slice(0, remaining)}${CLI_TIMELINE_TRUNCATED_SUFFIX}`,
    truncated: true,
  };
}

function extractReadableCliLineFromJson(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const eventType = typeof record.type === "string" ? record.type : "";

  if (eventType === "item.completed") {
    const item =
      record.item && typeof record.item === "object"
        ? (record.item as Record<string, unknown>)
        : null;
    const itemType = typeof item?.type === "string" ? item.type : "";
    const text = typeof item?.text === "string" ? item.text.trim() : "";
    if (!text) return null;
    if (itemType === "reasoning") return `[reasoning] ${text}`;
    if (itemType === "agent_message") return text;
    return `[${itemType || "item"}] ${text}`;
  }

  if (eventType === "message") {
    const role = typeof record.role === "string" ? record.role : "";
    const content =
      typeof record.content === "string" ? record.content.trim() : "";
    if (role === "assistant" && content) return content;
    return null;
  }

  if (eventType === "turn.completed") {
    const usage =
      record.usage && typeof record.usage === "object"
        ? (record.usage as Record<string, unknown>)
        : null;
    if (!usage) return "[turn] completed";
    const input =
      typeof usage.input_tokens === "number"
        ? usage.input_tokens
        : typeof usage.input === "number"
          ? usage.input
          : null;
    const output =
      typeof usage.output_tokens === "number"
        ? usage.output_tokens
        : typeof usage.output === "number"
          ? usage.output
          : null;
    const parts = ["[usage]"];
    if (typeof input === "number") parts.push(`input=${input}`);
    if (typeof output === "number") parts.push(`output=${output}`);
    return parts.join(" ");
  }

  if (eventType === "result") {
    const status =
      typeof record.status === "string" ? record.status : "unknown";
    const stats =
      record.stats && typeof record.stats === "object"
        ? (record.stats as Record<string, unknown>)
        : null;
    const durationMs =
      stats && typeof stats.duration_ms === "number" ? stats.duration_ms : null;
    const summary = [`[result] ${status}`];
    if (typeof durationMs === "number") {
      summary.push(`${durationMs}ms`);
    }
    return summary.join(" · ");
  }

  if (eventType === "thread.started") {
    return "[thread] started";
  }
  if (eventType === "turn.started") {
    return "[turn] started";
  }

  if (typeof record.text === "string" && record.text.trim()) {
    return record.text.trim();
  }

  return null;
}

function toReadableCliChunk(chunk: string): string {
  const normalized = chunk.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const readableLines = lines.map((line) => {
    if (!line.trim()) return "";
    return extractReadableCliLineFromJson(line) ?? line;
  });
  return readableLines.join("\n");
}

function applyCliCommandLogEvent(
  previousRuns: CliTimelineRun[],
  event: CliCommandLogEvent,
): CliTimelineRun[] {
  const next = previousRuns.slice();
  const runIndex = next.findIndex((run) => run.requestId === event.requestId);
  const hasRun = runIndex >= 0;
  const run = hasRun
    ? {
      ...next[runIndex],
      commands: next[runIndex].commands.map((command) => ({ ...command })),
    }
    : createCliTimelineRun(event.requestId, event.phase, event.timestamp);
  run.updatedAt = event.timestamp;
  if (!hasRun) {
    next.push(run);
  } else {
    next[runIndex] = run;
  }

  const ensureCommand = () => {
    const fallbackIndex = run.commands.length + 1;
    const commandId =
      withTrimmed(event.commandId ?? "") ||
      withTrimmed(event.agentId ?? "") ||
      `cmd_${fallbackIndex}`;
    const existingIndex = run.commands.findIndex(
      (command) => command.commandId === commandId,
    );
    if (existingIndex >= 0) {
      return existingIndex;
    }
    run.commands.push({
      commandId,
      agentId: event.agentId,
      agentLabel:
        withTrimmed(event.agentLabel ?? "") || `Command ${fallbackIndex}`,
      cli: event.agentCli,
      command: event.command,
      commandSource: event.commandSource,
      resolvedPath: event.resolvedPath,
      model: event.model,
      modelSource: event.modelSource,
      output: "",
      rawOutput: "",
      readableOutput: "",
      displayMode: "readable",
      status: "running",
      isStreaming: false,
      startedAt: event.timestamp,
      updatedAt: event.timestamp,
    });
    return run.commands.length - 1;
  };

  const requiresCommand =
    event.kind === "command_started" ||
    event.kind === "command_chunk" ||
    event.kind === "command_finished";
  const commandIndex = requiresCommand ? ensureCommand() : null;
  const command = commandIndex !== null ? run.commands[commandIndex] : null;

  switch (event.kind) {
    case "run_started":
      run.status = "running";
      break;
    case "command_started":
      run.status = "running";
      if (command) {
        if (event.agentId) command.agentId = event.agentId;
        if (event.agentLabel) command.agentLabel = event.agentLabel;
        if (event.agentCli) command.cli = event.agentCli;
        if (event.command) command.command = event.command;
        if (event.commandSource) command.commandSource = event.commandSource;
        if (event.resolvedPath) command.resolvedPath = event.resolvedPath;
        if (event.model) command.model = event.model;
        if (event.modelSource) command.modelSource = event.modelSource;
        command.isStreaming = true;
        command.status = "running";
        command.startedAt = event.timestamp;
        command.updatedAt = event.timestamp;
      }
      break;
    case "command_chunk":
      if (run.status !== "finished" && run.status !== "failed") {
        run.status = "running";
      }
      if (command) {
        const chunk = event.chunk ?? "";
        if (chunk) {
          const isStderr = event.stream === "stderr";
          const decoratedRawChunk = `${isStderr ? STDERR_ANSI_PREFIX : ""}${chunk}`;
          const readableChunk = isStderr
            ? decoratedRawChunk
            : toReadableCliChunk(chunk);

          const rawWithCap = appendCliTimelineChunkWithCap(
            command.rawOutput,
            decoratedRawChunk,
            command.truncated ?? false,
          );
          const readableWithCap = appendCliTimelineChunkWithCap(
            command.readableOutput,
            readableChunk,
            command.truncated ?? false,
          );
          command.rawOutput = rawWithCap.output;
          command.readableOutput = readableWithCap.output;
          command.output = command.readableOutput;
          command.truncated = rawWithCap.truncated || readableWithCap.truncated;
        }
        if (command.status !== "finished" && command.status !== "failed") {
          command.isStreaming = true;
          command.status = "running";
        }
        command.updatedAt = event.timestamp;
      }
      break;
    case "command_finished":
      if (command) {
        if (typeof event.exitCode === "number") {
          command.exitCode = event.exitCode;
          command.status = event.exitCode === 0 ? "finished" : "failed";
        } else if (command.status === "running") {
          command.status = "finished";
        }
        command.isStreaming = false;
        command.updatedAt = event.timestamp;
        command.endedAt = event.timestamp;
      }
      break;
    case "run_finished":
      run.status = "finished";
      run.error = undefined;
      run.commands = run.commands.map((item) => ({
        ...item,
        isStreaming: false,
        status: item.status === "running" ? "finished" : item.status,
        endedAt: item.endedAt ?? event.timestamp,
      }));
      break;
    case "run_failed":
      run.status = "failed";
      run.error = withTrimmed(event.chunk ?? "") || run.error;
      run.commands = run.commands.map((item) => ({
        ...item,
        isStreaming: false,
        status: item.status === "running" ? "failed" : item.status,
        endedAt: item.endedAt ?? event.timestamp,
      }));
      break;
    default:
      break;
  }

  return next;
}

// ── Settings persistence ──────────────────────────────────────────────────────
interface PersistedSettings {
  phase12Agents?: PhaseAgentRuntime[];
  phase3AgentACli?: string;
  phase3AgentBCli?: string;
  cliCommands?: AgentCliCommandMap;
  cliModels?: AgentCliModelMap;
  agentCliModels?: AgentCliModelPerAgentMap;
  // Legacy keys
  agentACli?: string;
  agentBCli?: string;
  phaseAgents?: PhaseAgentRuntime[];
  ollamaHost?: string;
  judgeProvider?: string;
  judgeModel?: string;
  phase3ReviewerCli?: string;
}

function readPersistedSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as PersistedSettings;
  } catch {
    return {};
  }
}

function isCliSetupCompleted(): boolean {
  try {
    return localStorage.getItem(CLI_SETUP_KEY_V2) === "1";
  } catch {
    return false;
  }
}

function markCliSetupCompleted(value: boolean): void {
  try {
    if (value) {
      localStorage.setItem(CLI_SETUP_KEY_V2, "1");
    } else {
      localStorage.removeItem(CLI_SETUP_KEY_V2);
    }
  } catch {
    // ignore
  }
}

// Legacy draft import compatibility only.
interface WorkflowDraft {
  requirement: string;
  clarifications: string;
  decision: string;
  phase1Result: Phase1Result | null;
  phase2Result: Phase2Result | null;
  frictionInboxDraft?: FrictionInboxDraft | null;
  workflowStep: WorkflowStep;
  savedAt: string;
}

function readDraft(): WorkflowDraft | null {
  try {
    const raw = localStorage.getItem(LEGACY_DRAFT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as WorkflowDraft;
  } catch {
    return null;
  }
}

export default function App() {
  const [routeState, setRouteState] = useState<RouteState>(() => {
    if (typeof window === "undefined") return DEFAULT_ROUTE_STATE;
    return { ...DEFAULT_ROUTE_STATE, ...readRouteStateFromLocation() };
  });

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionsDrawerOpen, setSessionsDrawerOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activePromptModelAgentId, setActivePromptModelAgentId] =
    useState("agent_a");
  const [cliSetupRequired, setCliSetupRequired] = useState(
    () => !isCliSetupCompleted(),
  );

  const [workflowStep, setWorkflowStep] = useState<WorkflowStep>("requirement");
  const [conversation, setConversation] = useState<ConversationItem[]>(() =>
    makeInitialConversation(),
  );
  const [composerText, setComposerText] = useState("");
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [currentSessionCreatedAt, setCurrentSessionCreatedAt] = useState<
    string | null
  >(null);

  const [requirement, setRequirement] = useState("");
  const [clarifications, setClarifications] = useState("");
  const [decision, setDecision] = useState("");
  const [frictionInboxDraft, setFrictionInboxDraft] =
    useState<FrictionInboxDraft | null>(null);

  const [phase1Result, setPhase1Result] = useState<Phase1Result | null>(null);
  const [phase2Result, setPhase2Result] = useState<Phase2Result | null>(null);
  const [phase3Result, setPhase3Result] = useState<Phase3Result | null>(null);

  const [repoPath, setRepoPath] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [proofModeOpen, setProofModeOpen] = useState(false);
  const [judgeProvider, setJudgeProvider] = useState<JudgeProvider>(() => {
    const s = readPersistedSettings();
    return ensureJudgeProvider(s.judgeProvider);
  });
  const [judgeModel, setJudgeModel] = useState(() => {
    const s = readPersistedSettings();
    return s.judgeModel ?? "";
  });
  const [phase12Agents, setPhase12Agents] = useState<PhaseAgentRuntime[]>(
    () => {
      const s = readPersistedSettings();
      const legacyA = ensureAgentCli(
        s.agentACli ?? s.phase3AgentACli,
        DEFAULT_AGENT_A_CLI,
      );
      const legacyB = ensureAgentCli(
        s.agentBCli ?? s.phase3AgentBCli ?? s.phase3ReviewerCli,
        DEFAULT_AGENT_B_CLI,
      );
      const baseDefaults = buildDefaultPhaseAgents(2);
      baseDefaults[0].cli = legacyA;
      baseDefaults[1].cli = legacyB;

      const storedPhase12 = s.phase12Agents ?? s.phaseAgents;
      if (!storedPhase12 || storedPhase12.length === 0) {
        return ensureAtLeastTwoPhaseAgents(baseDefaults);
      }

      return ensureAtLeastTwoPhaseAgents(normalizePhaseAgents(storedPhase12));
    },
  );
  const [phase3AgentACli, setPhase3AgentACli] = useState<AgentCli>(() => {
    const s = readPersistedSettings();
    return ensureAgentCli(
      s.phase3AgentACli ?? s.agentACli,
      ensureAtLeastTwoPhaseAgents(
        normalizePhaseAgents(
          s.phase12Agents ?? s.phaseAgents ?? buildDefaultPhaseAgents(2),
        ),
      )[0].cli,
    );
  });
  const [phase3AgentBCli, setPhase3AgentBCli] = useState<AgentCli>(() => {
    const s = readPersistedSettings();
    return ensureAgentCli(
      s.phase3AgentBCli ?? s.phase3ReviewerCli ?? s.agentBCli,
      ensureAtLeastTwoPhaseAgents(
        normalizePhaseAgents(
          s.phase12Agents ?? s.phaseAgents ?? buildDefaultPhaseAgents(2),
        ),
      )[1].cli,
    );
  });
  const [cliCommands, setCliCommands] = useState<AgentCliCommandMap>(() => {
    const s = readPersistedSettings();
    return normalizeCliCommands(s.cliCommands);
  });
  const [cliModels, setCliModels] = useState<AgentCliModelMap>(() => {
    const s = readPersistedSettings();
    return normalizeCliModels(s.cliModels);
  });
  const [agentCliModels, setAgentCliModels] =
    useState<AgentCliModelPerAgentMap>(() => {
      const s = readPersistedSettings();
      return normalizeAgentCliModels(s.agentCliModels);
    });
  const [ollamaHost, setOllamaHost] = useState(() => {
    const s = readPersistedSettings();
    return s.ollamaHost ?? "http://localhost:11434";
  });

  const [autoCleanup, setAutoCleanup] = useState(true);
  const [consentedToDataset, setConsentedToDataset] = useState(false);

  const [phase1Loading, setPhase1Loading] = useState(false);
  const [phase2Loading, setPhase2Loading] = useState(false);
  const [phase3Loading, setPhase3Loading] = useState(false);
  const [saveLocalLoading, setSaveLocalLoading] = useState(false);
  const [datasetLoading, setDatasetLoading] = useState(false);

  const [phase3FormError, setPhase3FormError] = useState<string | null>(null);
  const [recentSessions, setRecentSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [phase12Diagnostics, setPhase12Diagnostics] =
    useState<Phase12RuntimeDiagnostic | null>(null);
  const [phase12DiagnosticsLoading, setPhase12DiagnosticsLoading] =
    useState(false);
  const [phase12DiagnosticsError, setPhase12DiagnosticsError] = useState<
    string | null
  >(null);
  const [cliTimelineRuns, setCliTimelineRuns] = useState<CliTimelineRun[]>([]);
  const [cliModelInventory, setCliModelInventory] = useState<
    Partial<Record<AgentCli, CliAliasModelInventory>>
  >({});
  const [cliModelInventoryLoading, setCliModelInventoryLoading] = useState<
    Partial<Record<AgentCli, boolean>>
  >({});
  const [cliModelInventoryLoaded, setCliModelInventoryLoaded] = useState<
    Partial<Record<AgentCli, boolean>>
  >({});
  const [opencodeModels, setOpencodeModels] = useState<string[]>([]);
  const [opencodeModelsLoading, setOpencodeModelsLoading] = useState(false);
  const [opencodeModelsError, setOpencodeModelsError] = useState<string | null>(
    null,
  );

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmIntent, setConfirmIntent] = useState<ConfirmIntent | null>(
    null,
  );
  const confirmActionRef = useRef<(() => void) | null>(null);

  const [unsavedState, setUnsavedState] = useState<UnsavedState>({
    phase1Dirty: false,
    phase2Dirty: false,
    phase3Dirty: false,
  });

  const [showThreadScrollToBottom, setShowThreadScrollToBottom] =
    useState(false);
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);
  const threadSurfaceRef = useRef<HTMLDivElement | null>(null);
  const threadViewportRef = useRef<HTMLElement | null>(null);
  const threadAutoScrollRef = useRef(true);
  const onboardingAutoSelectAppliedRef = useRef(false);
  const lastInventoryRefreshSignatureRef = useRef("");
  const activeCliTimelineRequestIdsRef = useRef<Set<string>>(new Set());
  const pendingCliEventsRef = useRef<CliCommandLogEvent[]>([]);
  const cliEventFlushTimerRef = useRef<number | null>(null);
  const handleLoadSessionRef = useRef<(id: string) => void>(() => { });
  const handleRestartRef = useRef<() => void>(() => { });
  const submitWorkflowInputRef = useRef<
    (input: string) => Promise<void> | void
  >(() => { });
  const autosaveTimerRef = useRef<number | null>(null);
  const isHydratingSessionRef = useRef(false);

  function focusComposerInput() {
    window.setTimeout(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        ".chat-composer-wrap textarea[name='message']",
      );
      textarea?.focus();
    }, 0);
  }

  const getThreadViewport = useCallback(() => {
    const current = threadViewportRef.current;
    if (current && document.body.contains(current)) {
      return current;
    }
    const surface = threadSurfaceRef.current;
    if (!surface) return null;
    const viewport = surface.querySelector<HTMLElement>(".aui-thread-viewport");
    threadViewportRef.current = viewport;
    return viewport;
  }, []);

  const syncThreadScrollState = useCallback(() => {
    const viewport = getThreadViewport();
    if (!viewport) {
      threadAutoScrollRef.current = true;
      setShowThreadScrollToBottom(false);
      return;
    }
    const distanceToBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const nearBottom =
      distanceToBottom <= THREAD_SCROLL_BOTTOM_VISIBILITY_THRESHOLD_PX;
    threadAutoScrollRef.current = nearBottom;
    setShowThreadScrollToBottom(!nearBottom);
  }, [getThreadViewport]);

  const scrollThreadToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const viewport = getThreadViewport();
      if (viewport) {
        viewport.scrollTo({
          top: viewport.scrollHeight,
          behavior,
        });
        threadAutoScrollRef.current = true;
        setShowThreadScrollToBottom(false);
        return;
      }
      scrollAnchorRef.current?.scrollIntoView({
        behavior,
        block: "end",
      });
      threadAutoScrollRef.current = true;
      setShowThreadScrollToBottom(false);
    },
    [getThreadViewport],
  );

  const isBusy =
    phase1Loading || phase2Loading || phase3Loading || datasetLoading;
  const activeProblemStatement = useMemo(() => {
    const submitted = withTrimmed(requirement);
    if (submitted) return submitted;
    return withTrimmed(composerText);
  }, [composerText, requirement]);
  const hasMeaningfulSessionContent = useMemo(() => {
    if (
      nonWhitespaceLength(activeProblemStatement) >= AUTOSAVE_MIN_NON_WHITESPACE
    ) {
      return true;
    }
    if (phase1Result || phase2Result || phase3Result) {
      return true;
    }
    return conversation.some((item) => item.type === "user");
  }, [
    activeProblemStatement,
    conversation,
    phase1Result,
    phase2Result,
    phase3Result,
  ]);
  const hasUnsaved =
    unsavedState.phase1Dirty ||
    unsavedState.phase2Dirty ||
    unsavedState.phase3Dirty;
  const canPersistSession = hasMeaningfulSessionContent;
  const phase12AgentsSafe = useMemo(
    () => ensureAtLeastTwoPhaseAgents(phase12Agents),
    [phase12Agents],
  );
  const promptModelAgentIds = useMemo(() => {
    if (workflowStep === "phase3_run") {
      return ["phase3_agent_a", "phase3_agent_b"];
    }
    return phase12AgentsSafe
      .slice(0, MAX_PHASE_AGENTS)
      .map((agent) => agent.id);
  }, [phase12AgentsSafe, workflowStep]);
  const runtimeSettings = useMemo<RuntimeSettings>(
    () => ({
      phase12Agents: phase12AgentsSafe,
      phase3AgentACli,
      phase3AgentBCli,
      cliCommands,
      cliModels,
      agentCliModels,
      judgeProvider,
      judgeModel,
      ollamaHost,
      promptBundleVersion: PROMPT_BUNDLE_VERSION,
    }),
    [
      phase12AgentsSafe,
      phase3AgentACli,
      phase3AgentBCli,
      cliCommands,
      cliModels,
      agentCliModels,
      judgeProvider,
      judgeModel,
      ollamaHost,
    ],
  );
  const onboardingCliAliases = useMemo<AgentCli[]>(() => {
    const aliases: AgentCli[] = [];
    phase12AgentsSafe.slice(0, 2).forEach((agent) => {
      if (!aliases.includes(agent.cli)) {
        aliases.push(agent.cli);
      }
    });
    return aliases;
  }, [phase12AgentsSafe]);
  const onboardingCliStatuses = useMemo<CliOnboardingStatus[]>(() => {
    const diagnostics = phase12Diagnostics?.agents.slice(0, 2) ?? [];
    return onboardingCliAliases.map((cli) => {
      const matched =
        diagnostics.find(
          (agent, index) =>
            expectedPhase12CliForDiagnostic(agent, index) === cli,
        ) ?? diagnostics.find((agent) => agent.selectedCli === cli);
      const configuredCommand = cliCommands[cli] ?? "";
      const selectedMatches = matched ? matched.selectedCli === cli : false;
      const resolvedPath = matched?.resolvedBinaryPath ?? "";
      const isExecutable = selectedMatches && resolvedPath.trim().length > 0;
      const isReady = matched?.runtimeReady ?? true;

      let detail = "No diagnostics yet.";
      if (phase12DiagnosticsError) {
        detail = phase12DiagnosticsError;
      } else if (!matched) {
        detail = "No backend diagnostic entry for this CLI.";
      } else if (!selectedMatches) {
        detail = `Backend received '${matched.selectedCli}' for this slot.`;
      } else if (!resolvedPath) {
        detail =
          "Command not found in PATH. Set an absolute command path here or switch Agent A/B CLI to an installed executable.";
      } else if (!isReady) {
        detail =
          matched.readinessReason?.trim() ||
          "Codex auth missing in isolated runtime. Run `codex login` or choose another CLI.";
      } else if (matched.requiresAuth) {
        detail = `Executable found. Auth ready (${matched.readinessSource ?? "none"}).`;
      } else {
        detail = "Executable found.";
      }

      return {
        cli,
        configuredCommand,
        resolvedCommand: matched?.resolvedCommand ?? "",
        source: matched?.resolvedCommandSource ?? "",
        resolvedPath,
        resolvedModel: matched?.resolvedModel,
        resolvedModelSource: matched?.resolvedModelSource,
        isExecutable,
        isReady,
        selectedMatches,
        detail,
      };
    });
  }, [
    cliCommands,
    onboardingCliAliases,
    phase12Diagnostics,
    phase12DiagnosticsError,
    phase12AgentsSafe,
  ]);
  const canConfirmCliSetup = useMemo(() => {
    if (onboardingCliAliases.length === 0) return false;
    if (phase12DiagnosticsLoading) return false;
    if (phase12DiagnosticsError) return false;
    return onboardingCliStatuses.every(
      (status) => status.isExecutable && status.isReady,
    );
  }, [
    onboardingCliAliases.length,
    onboardingCliStatuses,
    phase12DiagnosticsError,
    phase12DiagnosticsLoading,
  ]);
  const hasAnyOpencodeAgent = useMemo(() => {
    if (phase12AgentsSafe.some((agent) => agent.cli === "opencode"))
      return true;
    if (phase3AgentACli === "opencode") return true;
    if (phase3AgentBCli === "opencode") return true;
    return false;
  }, [phase12AgentsSafe, phase3AgentACli, phase3AgentBCli]);
  const visibleCliAliases = useMemo<AgentCli[]>(
    () =>
      uniqueCliAliases([
        ...phase12AgentsSafe.map((agent) => agent.cli),
        phase3AgentACli,
        phase3AgentBCli,
      ]),
    [phase12AgentsSafe, phase3AgentACli, phase3AgentBCli],
  );
  const cliCommandsSignature = useMemo(
    () =>
      AGENT_CLI_OPTIONS.map(
        (alias) => `${alias}:${cliCommands[alias] ?? ""}`,
      ).join("|"),
    [cliCommands],
  );
  const inventoryRefreshSignature = useMemo(() => {
    const aliasesKey = [...visibleCliAliases].sort().join(",");
    return `${aliasesKey}|${cliCommandsSignature}|${ollamaHost}`;
  }, [visibleCliAliases, cliCommandsSignature, ollamaHost]);
  const artifactRefreshTokens = useMemo(() => {
    const tokens = new Map<string, string>();
    conversation.forEach((item) => {
      if (!isArtifactConversationItem(item)) return;

      if (item.type === "cli_timeline") {
        const run = cliTimelineRuns.find(
          (entry) => entry.requestId === item.payload.requestId,
        );
        if (!run) return;
        const commandStamp = run.commands
          .map((command) => {
            return `${command.commandId}:${command.status}:${command.exitCode ?? ""}:${command.updatedAt}:${command.rawOutput.length}:${command.readableOutput.length}`;
          })
          .join("|");
        tokens.set(
          item.id,
          `${run.status}:${run.updatedAt}:${run.commands.length}:${commandStamp}`,
        );
        return;
      }

      if (item.type === "friction_phase1" || item.type === "friction_inbox") {
        if (!frictionInboxDraft) return;
        const resolvedCount = frictionInboxDraft.resolutions.filter(
          (resolution) => Boolean(resolution.choice),
        ).length;
        tokens.set(
          item.id,
          `${frictionInboxDraft.status}:${frictionInboxDraft.direction ?? ""}:${phase2Loading ? "1" : "0"}:${resolvedCount}:${withTrimmed(frictionInboxDraft.contextNote).length}`,
        );
        return;
      }

      if (item.type === "execution_brief") {
        const brief = phase2Result?.executionBrief
          ? JSON.stringify(phase2Result.executionBrief)
          : "";
        tokens.set(
          item.id,
          [
            workflowStep,
            phase2Loading ? "1" : "0",
            phase3Loading ? "1" : "0",
            saveLocalLoading ? "1" : "0",
            datasetLoading ? "1" : "0",
            withTrimmed(repoPath),
            withTrimmed(baseBranch),
            consentedToDataset ? "1" : "0",
            withTrimmed(phase3FormError ?? ""),
            withTrimmed(saveStatus ?? ""),
            brief,
          ].join(":"),
        );
        return;
      }
    });
    return tokens;
  }, [
    baseBranch,
    cliTimelineRuns,
    consentedToDataset,
    conversation,
    datasetLoading,
    decision,
    frictionInboxDraft,
    phase2Loading,
    phase2Result,
    phase3FormError,
    phase3Loading,
    repoPath,
    saveLocalLoading,
    saveStatus,
    workflowStep,
  ]);
  const previousAssistantThreadMessagesRef = useRef<
    Map<string, { id: string; role: "assistant" | "user"; content: string }>
  >(new Map());
  const assistantThreadMessages = useMemo(() => {
    const previousById = previousAssistantThreadMessagesRef.current;
    const nextById = new Map<
      string,
      { id: string; role: "assistant" | "user"; content: string }
    >();
    const nextMessages: {
      id: string;
      role: "assistant" | "user";
      content: string;
    }[] = [];

    conversation.forEach((item) => {
      const mapped = conversationItemToAssistantThreadMessage(
        item,
        artifactRefreshTokens,
      );
      if (!mapped) return;

      const previous = previousById.get(mapped.id);
      if (
        previous &&
        previous.role === mapped.role &&
        previous.content === mapped.content
      ) {
        nextMessages.push(previous);
        nextById.set(previous.id, previous);
        return;
      }

      nextMessages.push(mapped);
      nextById.set(mapped.id, mapped);
    });

    previousAssistantThreadMessagesRef.current = nextById;
    return nextMessages;
  }, [conversation, artifactRefreshTokens]);
  const assistantThreadListItems = useMemo(() => {
    return recentSessions.map((session) => ({
      status: "regular" as const,
      id: session.id,
      title: withTrimmed(session.title) || session.id.slice(0, 8),
    }));
  }, [recentSessions]);
  const conversationArtifactById = useMemo(() => {
    const byId = new Map<string, ConversationItem>();
    conversation.forEach((item) => {
      if (isArtifactConversationItem(item)) {
        byId.set(item.id, item);
      }
    });
    return byId;
  }, [conversation]);
  const renderConversationArtifact = useCallback(
    (item: ConversationItem) => {
      if (item.type === "cli_timeline") {
        const run = cliTimelineRuns.find(
          (entry) => entry.requestId === item.payload.requestId,
        );
        if (!run) {
          return null;
        }
        return <CommandTimelineCard run={run} />;
      }

      if (item.type === "friction_phase1") {
        const sourcePhase1 = item.payload.phase1;
        if (!sourcePhase1 || !frictionInboxDraft) {
          return (
            <p className="text-xs text-friction-muted">
              Preparing friction points…
            </p>
          );
        }
        const cardAgents = phase1AgentsFromResult(
          sourcePhase1,
          phase12AgentsSafe,
        );
        const topDisagreements = deriveTopDisagreements(sourcePhase1);
        return (
          <FrictionPhase1Inline
            phase1={sourcePhase1}
            topDisagreements={topDisagreements}
            agents={cardAgents}
            draft={frictionInboxDraft}
            submitting={phase2Loading}
            onDirectionChange={updateFrictionDirection}
            onContextNoteChange={updateFrictionContextNote}
            onResolutionChange={updateFrictionResolution}
            onSubmit={(draftOverride) => {
              void submitFrictionInbox(draftOverride);
            }}
          />
        );
      }

      if (item.type === "friction_inbox") {
        const sourcePhase1 = phase1Result;
        if (!sourcePhase1 || !frictionInboxDraft) {
          return (
            <p className="text-xs text-friction-muted">
              Preparing friction points…
            </p>
          );
        }
        const cardAgents = phase1AgentsFromResult(
          sourcePhase1,
          phase12AgentsSafe,
        );
        const topDisagreements = deriveTopDisagreements(sourcePhase1);
        return (
          <FrictionPhase1Inline
            phase1={sourcePhase1}
            topDisagreements={topDisagreements}
            agents={cardAgents}
            draft={frictionInboxDraft}
            submitting={phase2Loading}
            onDirectionChange={updateFrictionDirection}
            onContextNoteChange={updateFrictionContextNote}
            onResolutionChange={updateFrictionResolution}
            onSubmit={(draftOverride) => {
              void submitFrictionInbox(draftOverride);
            }}
          />
        );
      }

      if (item.type === "execution_brief") {
        const brief =
          phase2Result?.actionBrief ??
          phase2Result?.executionBrief ??
          item.payload.brief;
        if (!brief) {
          return (
            <p className="text-xs text-friction-muted">
              Preparing action brief…
            </p>
          );
        }
        return (
          <ExecutionBriefCard
            brief={brief}
            canPersistSession={canPersistSession}
            saveLocalLoading={saveLocalLoading}
            datasetLoading={datasetLoading}
            repoPath={repoPath}
            baseBranch={baseBranch}
            proofModeOpen={proofModeOpen}
            consentedToDataset={consentedToDataset}
            phase3Loading={phase3Loading}
            phase3FormError={phase3FormError}
            onSave={() => {
              void handleSaveSessionLocal();
            }}
            onExportSession={handleExportSession}
            onExportDataset={() => {
              void handleExportDataset();
            }}
            onNewThread={handleRestart}
            onProofModeOpenChange={(value) => {
              setProofModeOpen(value);
              setUnsavedState((prev) => ({ ...prev, phase3Dirty: true }));
            }}
            onRepoPathChange={(value) => {
              setRepoPath(value);
              setUnsavedState((prev) => ({ ...prev, phase3Dirty: true }));
            }}
            onBaseBranchChange={(value) => {
              setBaseBranch(value);
              setUnsavedState((prev) => ({ ...prev, phase3Dirty: true }));
            }}
            onDatasetOptInChange={(value) => {
              setConsentedToDataset(value);
              setUnsavedState((prev) => ({ ...prev, phase3Dirty: true }));
            }}
            onRunPhase3={() => {
              void handlePhase3Step();
            }}
          />
        );
      }

      if (item.type === "task") {
        return (
          <article className="chat-task-card">
            <p className="text-sm font-semibold text-friction-text">
              {item.payload.title}
            </p>
            {item.payload.description ? (
              <p className="mt-1 text-sm text-friction-muted">
                {item.payload.description}
              </p>
            ) : null}
            <SuggestionChips
              suggestions={item.payload.suggestions ?? []}
              onPick={handleSuggestionPick}
            />
          </article>
        );
      }

      if (item.type === "plan") {
        if (item.payload.phase === 1 && item.payload.phase1) {
          const p1 = item.payload.phase1;
          const p1Agents = phase1AgentsFromResult(p1, phase12AgentsSafe);
          return (
            <PlanCard
              title="Phase 1 — Multi-agent interpretation"
              summary={`${p1.divergences.length} friction point${p1.divergences.length !== 1 ? "s" : ""} · ${p1Agents.length} agent${p1Agents.length > 1 ? "s" : ""}`}
              defaultOpen={false}
            >
              <DivergenceBlock
                title="Friction points"
                divergences={p1.divergences}
                leftLabel={p1Agents[0]?.label ?? "Agent A"}
                rightLabel={p1Agents[1]?.label ?? "Agent B"}
              />
              <div className="mt-4 grid gap-4 xl:grid-cols-2">
                {p1Agents.map((agent, index) => (
                  <AgentCard
                    key={`${agent.id}-${index}`}
                    title={agent.label}
                    tone={index % 2 === 0 ? "steel" : "ember"}
                    payload={agent.response}
                    fields={[
                      "interpretation",
                      "assumptions",
                      "risks",
                      "questions",
                      "approach",
                    ]}
                    model={`cli:${agent.cli}`}
                  />
                ))}
              </div>
            </PlanCard>
          );
        }

        if (item.payload.phase === 2 && item.payload.phase2) {
          const p2 = item.payload.phase2;
          const p2Agents = phase2AgentsFromResult(p2, phase12AgentsSafe);
          return (
            <PlanCard
              title="Phase 2 — Multi-agent approaches"
              summary={`${p2.divergences.length} approach divergence${p2.divergences.length !== 1 ? "s" : ""} · ${p2Agents.length} variants`}
              defaultOpen={false}
            >
              <DivergenceBlock
                title="Approach divergences"
                divergences={p2.divergences}
                leftLabel={p2Agents[0]?.label ?? "Agent A"}
                rightLabel={p2Agents[1]?.label ?? "Agent B"}
              />
              <div className="mt-4 grid gap-4 xl:grid-cols-2">
                {p2Agents.map((agent, index) => (
                  <PlanPanel
                    key={`${agent.id}-${index}`}
                    title={agent.label}
                    tone={index % 2 === 0 ? "steel" : "ember"}
                    plan={agent.plan}
                    divergences={p2.divergences}
                  />
                ))}
              </div>
            </PlanCard>
          );
        }
      }

      if (item.type === "code") {
        return (
          <CodeCard
            title="Proof mode output"
            summary={`Repo: ${item.payload.repoPath} · Branch: ${item.payload.baseBranch} · Confidence ${formatPercent(item.payload.phase3.confidenceScore)}`}
          >
            <DiffViewer phase3={item.payload.phase3} />
          </CodeCard>
        );
      }

      return null;
    },
    [
      cliTimelineRuns,
      frictionInboxDraft,
      handleSuggestionPick,
      phase1Result,
      phase12AgentsSafe,
      phase2Loading,
      phase2Result,
      phase3FormError,
      phase3Loading,
      repoPath,
      baseBranch,
      consentedToDataset,
      proofModeOpen,
      canPersistSession,
      saveLocalLoading,
      datasetLoading,
      handleExportDataset,
      handleExportSession,
      handleRestart,
      handleSaveSessionLocal,
      submitFrictionInbox,
      updateFrictionContextNote,
      updateFrictionDirection,
      updateFrictionResolution,
      isBusy,
      handlePhase3Step,
    ],
  );
  const conversationArtifactByIdRef = useRef(conversationArtifactById);
  const renderConversationArtifactRef = useRef(renderConversationArtifact);

  useEffect(() => {
    conversationArtifactByIdRef.current = conversationArtifactById;
  }, [conversationArtifactById]);

  useEffect(() => {
    renderConversationArtifactRef.current = renderConversationArtifact;
  }, [renderConversationArtifact]);

  const AssistantThreadText = useCallback((props: any) => {
    const raw =
      (typeof props?.text === "string" && props.text) ||
      (typeof props?.children === "string" && props.children) ||
      "";
    const artifactId = parseThreadArtifactMarker(raw);
    if (artifactId) {
      const item = conversationArtifactByIdRef.current.get(artifactId);
      if (!item) {
        return null;
      }
      const rendered = renderConversationArtifactRef.current(item);
      if (rendered) {
        return (
          <div className="thread-artifact-root" data-artifact-type={item.type}>
            {rendered}
          </div>
        );
      }
      return (
        <div className="thread-artifact-root">
          <p className="text-xs text-friction-muted">
            Preparing artifact output…
          </p>
        </div>
      );
    }
    return (
      <div className="thread-assistant-text">
        <MarkdownText {...props} />
      </div>
    );
  }, []);
  useEffect(() => {
    handleLoadSessionRef.current = handleLoadSession;
    handleRestartRef.current = handleRestart;
    submitWorkflowInputRef.current = submitWorkflowInput;
  });

  const handleThreadSwitchToThread = useCallback(async (threadId: string) => {
    handleLoadSessionRef.current(threadId);
  }, []);

  const handleThreadSwitchToNewThread = useCallback(async () => {
    handleRestartRef.current();
  }, []);

  const handleThreadNewMessage = useCallback(
    async (message: { content: unknown }) => {
      const text = extractThreadTextContent(message.content);
      if (!text) return;
      await submitWorkflowInputRef.current(text);
    },
    [],
  );

  const assistantThreadStoreAdapter = useMemo(
    () => ({
      isRunning: isBusy,
      messages: assistantThreadMessages,
      adapters: {
        threadList: {
          threadId: routeState.sessionId ?? undefined,
          threads: assistantThreadListItems,
          onSwitchToThread: handleThreadSwitchToThread,
          onSwitchToNewThread: handleThreadSwitchToNewThread,
        },
      },
      onNew: handleThreadNewMessage,
      convertMessage: (message: {
        id: string;
        role: "assistant" | "user";
        content: string;
      }) => ({
        id: message.id,
        role: message.role,
        content: message.content,
      }),
    }),
    [
      isBusy,
      assistantThreadMessages,
      routeState.sessionId,
      assistantThreadListItems,
      handleThreadSwitchToThread,
      handleThreadSwitchToNewThread,
      handleThreadNewMessage,
    ],
  );

  const assistantThreadRuntime = useExternalStoreRuntime(
    assistantThreadStoreAdapter,
  );
  const threadWelcome = useMemo(
    () => ({
      message:
        "Describe the problem statement. I will run phase 1 automatically after you send.",
    }),
    [],
  );
  const threadAssistantMessageConfig = useMemo(
    () => ({
      allowReload: false,
      allowCopy: true,
      allowSpeak: false,
      allowFeedbackPositive: false,
      allowFeedbackNegative: false,
      components: {
        Text: AssistantThreadText,
      },
    }),
    [AssistantThreadText],
  );
  const threadComponents = useMemo(
    () => ({
      Composer: () => null,
      AssistantMessage: AssistantMessageArtifactAware,
    }),
    [],
  );
  const threadStrings = useMemo(
    () => ({
      composer: {
        input: {
          placeholder: PROMPT_HINTS[workflowStep],
        },
      },
    }),
    [workflowStep],
  );

  function updateRoute(
    mutator: (prev: RouteState) => RouteState,
    mode: "replace" | "push",
  ) {
    setRouteState((prev) => {
      const next = mutator(prev);
      applyRouteState(next, mode);
      return next;
    });
  }

  function transitionWorkflow(
    next: WorkflowStep,
    mode: "replace" | "push" = "replace",
  ) {
    setWorkflowStep(next);
    updateRoute((prev) => ({ ...prev, phase: phaseFromStep(next) }), mode);
  }

  function appendConversation(item: ConversationItem) {
    setConversation((prev) => [...prev, item]);
  }

  function appendText(
    type: "user" | "assistant",
    text: string,
    step: WorkflowStep,
  ) {
    appendConversation({
      id: crypto.randomUUID(),
      type,
      text,
      meta: metaFor(step),
    });
  }

  function appendStatus(
    label: string,
    step: WorkflowStep,
    detail?: string,
    running?: boolean,
  ) {
    appendConversation({
      id: crypto.randomUUID(),
      type: running ? "tool" : "status",
      payload: {
        label,
        detail,
        running,
        meta: metaFor(step),
      },
    });
  }

  function appendError(message: string, step: WorkflowStep) {
    appendConversation({
      id: crypto.randomUUID(),
      type: "error",
      payload: {
        message,
        recoverable: true,
        meta: metaFor(step),
      },
    });
  }

  function resetCliTimelineRuns() {
    activeCliTimelineRequestIdsRef.current.clear();
    pendingCliEventsRef.current = [];
    if (cliEventFlushTimerRef.current !== null) {
      window.clearTimeout(cliEventFlushTimerRef.current);
      cliEventFlushTimerRef.current = null;
    }
    setCliTimelineRuns([]);
  }

  function startCliTimelineRun(phase: 1 | 2 | 3, step: WorkflowStep): string {
    const requestId = crypto.randomUUID();
    activeCliTimelineRequestIdsRef.current.add(requestId);
    setCliTimelineRuns((previous) => [
      ...previous,
      createCliTimelineRun(requestId, phase),
    ]);
    appendConversation({
      id: crypto.randomUUID(),
      type: "cli_timeline",
      payload: {
        requestId,
        phase,
        meta: metaFor(step),
      },
    });
    return requestId;
  }

  function finalizeCliTimelineRun(
    requestId: string,
    status: "finished" | "failed",
    error?: string,
  ) {
    activeCliTimelineRequestIdsRef.current.delete(requestId);
    setCliTimelineRuns((previous) =>
      previous.map((run) => {
        if (run.requestId !== requestId) return run;
        return {
          ...run,
          status,
          updatedAt: new Date().toISOString(),
          error:
            status === "failed"
              ? withTrimmed(error ?? "") || run.error
              : undefined,
          commands: run.commands.map((command) => ({
            ...command,
            isStreaming: false,
            status: command.status === "running" ? status : command.status,
            endedAt: command.endedAt ?? new Date().toISOString(),
          })),
        };
      }),
    );
  }

  function appendTask(
    title: string,
    step: WorkflowStep,
    description?: string,
    suggestions: string[] = [],
  ) {
    appendConversation({
      id: crypto.randomUUID(),
      type: "task",
      payload: {
        title,
        description,
        suggestions,
        done: false,
        meta: metaFor(step),
      },
    });
  }

  function updateFrictionResolution(
    frictionKey: string,
    patch: Partial<{ choice: FrictionResolutionChoice; rationale: string }>,
  ) {
    setUnsavedState((previous) => ({ ...previous, phase2Dirty: true }));
    setFrictionInboxDraft((previous) => {
      if (!previous) return previous;
      const nextResolutions = previous.resolutions.map((item) => {
        if (item.key !== frictionKey) return item;
        const normalizedChoice = normalizeFrictionChoice(patch.choice);
        return {
          ...item,
          choice: normalizedChoice ?? item.choice,
          rationale:
            typeof patch.rationale === "string"
              ? patch.rationale
              : item.rationale,
        };
      });
      const nextDraft: FrictionInboxDraft = {
        ...previous,
        resolutions: nextResolutions,
      };
      if (phase1Result) {
        nextDraft.status = computeFrictionGateState(phase1Result, nextDraft)
          .ready
          ? "ready"
          : "draft";
      } else {
        nextDraft.status = "draft";
      }
      return nextDraft;
    });
  }

  function updateFrictionDirection(direction?: FrictionResolutionChoice) {
    setUnsavedState((previous) => ({ ...previous, phase2Dirty: true }));
    setFrictionInboxDraft((previous) => {
      if (!previous) return previous;
      const normalizedDirection = normalizeFrictionChoice(direction);
      const nextDraft: FrictionInboxDraft = {
        ...previous,
        direction: normalizedDirection,
      };
      return nextDraft;
    });
  }

  function updateFrictionContextNote(value: string) {
    setUnsavedState((previous) => ({ ...previous, phase2Dirty: true }));
    setFrictionInboxDraft((previous) => {
      if (!previous) return previous;
      const nextDraft: FrictionInboxDraft = {
        ...previous,
        contextNote: value,
      };
      return nextDraft;
    });
  }

  async function submitFrictionInbox(draftOverride?: FrictionInboxDraft) {
    const effectiveDraft = draftOverride ?? frictionInboxDraft;
    if (!phase1Result || !requirement || !effectiveDraft) {
      appendError("Analyze the problem statement first.", "friction");
      transitionWorkflow("requirement");
      return;
    }

    const gate = computeFrictionGateState(phase1Result, effectiveDraft);
    if (!gate.ready) {
      appendError(
        "Pick a side or hybrid for each of the top disagreements before generating the brief.",
        "friction",
      );
      return;
    }

    if (draftOverride) {
      setFrictionInboxDraft(draftOverride);
    }
    const phase1Agents = phase1AgentsFromResult(
      phase1Result,
      phase12AgentsSafe,
    );
    const clarificationsText = buildClarificationsFromFrictionInbox(
      phase1Result,
      effectiveDraft,
      phase1Agents,
    );
    await handleClarificationsStep(clarificationsText, effectiveDraft);
  }

  function validateRequirement(value: string): string | null {
    if (withTrimmed(value).length < 8)
      return "Problem statement must be at least 8 characters.";
    return null;
  }

  function validateClarifications(value: string): string | null {
    if (withTrimmed(value).length < 3)
      return "Clarifications payload is empty.";
    return null;
  }

  function extractErrorMessage(caught: unknown): string {
    if (caught instanceof Error && withTrimmed(caught.message)) {
      return withTrimmed(caught.message);
    }
    if (typeof caught === "string" && withTrimmed(caught)) {
      return withTrimmed(caught);
    }
    if (caught && typeof caught === "object") {
      const source = caught as Record<string, unknown>;
      const directKeys = ["message", "error", "detail", "details", "reason"];
      for (const key of directKeys) {
        const value = source[key];
        if (typeof value === "string" && withTrimmed(value)) {
          return withTrimmed(value);
        }
      }
      if (source.cause) {
        const nested = extractErrorMessage(source.cause);
        if (nested !== "Unknown error") return nested;
      }
      try {
        const serialized = JSON.stringify(source);
        if (withTrimmed(serialized) && serialized !== "{}") {
          return serialized;
        }
      } catch {
        // ignore
      }
    }
    return "Unknown error";
  }

  async function refreshRecentSessions() {
    try {
      const sessions = await listSavedSessions(8);
      setRecentSessions(sessions);
    } catch (caught) {
      const message = extractErrorMessage(caught);
      setError(`Failed to load sessions: ${message}`);
      setRecentSessions([]);
    }
  }

  function queueConfirmation(intent: ConfirmIntent, action: () => void) {
    confirmActionRef.current = action;
    setConfirmIntent(intent);
    setConfirmOpen(true);
  }

  function guardUnsaved(action: () => void, intent: ConfirmIntent) {
    if (!hasUnsaved) {
      action();
      return;
    }
    queueConfirmation(intent, action);
  }

  function handleSettingsOpenChange(open: boolean) {
    setSettingsOpen(open);
  }

  function handleConfirmCliSetup() {
    if (!canConfirmCliSetup) {
      const message =
        "CLI setup cannot be confirmed yet. Ensure selected Agent A/B CLI commands are executable.";
      setError(message);
      appendError(message, workflowStep);
      return;
    }
    markCliSetupCompleted(true);
    setCliSetupRequired(false);
    setSettingsOpen(false);
    setSaveStatus("CLI setup confirmed.");
  }

  function handleResetRuntimeSettings() {
    markCliSetupCompleted(false);
    const defaults = buildDefaultPhaseAgents(2);
    setPhase12Agents(defaults);
    setPhase3AgentACli(defaults[0].cli);
    setPhase3AgentBCli(defaults[1].cli);
    setCliCommands({});
    setCliModels({});
    setAgentCliModels({});
    setPhase12Diagnostics(null);
    setPhase12DiagnosticsError(null);
    setOpencodeModels([]);
    setOpencodeModelsError(null);
    setJudgeProvider(DEFAULT_JUDGE_PROVIDER);
    setJudgeModel("");
    setOllamaHost("http://localhost:11434");
    setAutoCleanup(true);
    setCliSetupRequired(true);
    setSettingsOpen(false);

    try {
      localStorage.removeItem(SETTINGS_KEY);
      localStorage.removeItem("friction.agentACli");
      localStorage.removeItem("friction.agentBCli");
      localStorage.removeItem("friction.phaseAgents");
      localStorage.removeItem("friction.phase12Agents");
      localStorage.removeItem(CLI_SETUP_KEY_V2);
      localStorage.removeItem(CLI_SETUP_KEY_LEGACY_V1);
    } catch {
      // ignore
    }

    appendStatus(
      "Runtime reset",
      workflowStep,
      "Runtime settings reset to defaults. Confirm Agent A/B CLI to continue.",
      false,
    );
  }

  function handleRerunCliOnboarding() {
    markCliSetupCompleted(false);
    setCliSetupRequired(true);
    setSettingsOpen(false);
    setSaveStatus("CLI onboarding re-opened.");
  }

  function handleCliCommandChange(cli: AgentCli, value: string) {
    setCliCommands((previous) => {
      const trimmed = value.trim();
      if (!trimmed) {
        const { [cli]: _, ...rest } = previous;
        return rest;
      }
      return {
        ...previous,
        [cli]: trimmed,
      };
    });
  }

  function handleCliModelChange(cli: AgentCli, value: string) {
    setCliModels((previous) => {
      const trimmed = value.trim();
      if (!trimmed) {
        const { [cli]: _, ...rest } = previous;
        return rest;
      }
      return {
        ...previous,
        [cli]: trimmed,
      };
    });
  }

  function handleAgentCliModelChange(agentId: string, value: string) {
    setAgentCliModels((previous) => {
      const trimmed = value.trim();
      if (!trimmed) {
        const { [agentId]: _, ...rest } = previous;
        return rest;
      }
      return {
        ...previous,
        [agentId]: trimmed,
      };
    });
  }

  function handleAgentCliChange(agentId: string, cli: AgentCli) {
    if (agentId === "phase3_agent_a") {
      setPhase3AgentACli(cli);
      return;
    }
    if (agentId === "phase3_agent_b") {
      setPhase3AgentBCli(cli);
      return;
    }

    setPhase12Agents((previous) => {
      const safe = ensureAtLeastTwoPhaseAgents(previous).slice(
        0,
        MAX_PHASE_AGENTS,
      );
      return safe.map((agent) =>
        agent.id === agentId ? { ...agent, cli } : agent,
      );
    });
  }

  function normalizePhase12AgentsForLength(
    source: PhaseAgentRuntime[],
    nextLength: number,
  ): PhaseAgentRuntime[] {
    const clampedLength = Math.max(2, Math.min(MAX_PHASE_AGENTS, nextLength));
    const safeSource = ensureAtLeastTwoPhaseAgents(source).slice(
      0,
      MAX_PHASE_AGENTS,
    );
    return PHASE_AGENT_PRESETS.slice(0, clampedLength).map((preset, index) => ({
      id: preset.id,
      label: preset.label,
      cli: ensureAgentCli(safeSource[index]?.cli, preset.defaultCli),
    }));
  }

  function handleAddPhase12Agent() {
    if (phase12AgentsSafe.length >= MAX_PHASE_AGENTS) return;
    const nextLength = Math.min(MAX_PHASE_AGENTS, phase12AgentsSafe.length + 1);
    const nextAgents = normalizePhase12AgentsForLength(
      phase12AgentsSafe,
      nextLength,
    );
    setPhase12Agents(nextAgents);
    const appended = nextAgents[nextAgents.length - 1];
    if (appended) {
      setActivePromptModelAgentId(appended.id);
    }
  }

  function handleRemovePhase12Agent(agentId: string) {
    if (agentId === "agent_a" || agentId === "agent_b") return;
    if (phase12AgentsSafe.length <= 2) return;

    const keptAgents = phase12AgentsSafe.filter(
      (agent) => agent.id !== agentId,
    );
    const nextAgents = normalizePhase12AgentsForLength(
      keptAgents,
      keptAgents.length,
    );
    setPhase12Agents(nextAgents);

    setAgentCliModels((previous) => {
      const next: AgentCliModelPerAgentMap = { ...previous };
      ["agent_a", "agent_b", "agent_c", "agent_d"].forEach((id) => {
        delete next[id];
      });

      nextAgents.forEach((nextAgent, index) => {
        const sourceAgent = keptAgents[index];
        if (!sourceAgent) return;
        const sourceModel = previous[sourceAgent.id];
        if (typeof sourceModel !== "string" || !sourceModel.trim()) return;
        next[nextAgent.id] = sourceModel.trim();
      });

      return next;
    });
  }

  async function refreshCliModelInventory(
    aliases: AgentCli[] = AGENT_CLI_OPTIONS,
    options?: {
      forceRefresh?: boolean;
    },
  ) {
    const targets = uniqueCliAliases(aliases);
    if (targets.length === 0) return;
    const startedAtByAlias = new Map<AgentCli, number>();
    targets.forEach((alias) => {
      startedAtByAlias.set(alias, performance.now());
    });

    setCliModelInventoryLoading((previous) => {
      const next = { ...previous };
      targets.forEach((alias) => {
        next[alias] = true;
      });
      return next;
    });

    try {
      const settled = await Promise.allSettled(
        targets.map((alias) =>
          listCliModels(alias, runtimeSettings, {
            forceRefresh: options?.forceRefresh ?? false,
          }),
        ),
      );
      const inventories: CliAliasModelInventory[] = [];
      let opencodeFailure: string | null = null;

      settled.forEach((result, index) => {
        const alias = targets[index];
        const durationMs = Math.max(
          1,
          Math.round(
            performance.now() -
            (startedAtByAlias.get(alias) ?? performance.now()),
          ),
        );
        const fetchedAt = new Date().toISOString();
        if (result.status === "fulfilled") {
          inventories.push({
            ...result.value,
            fetchDurationMs: result.value.fetchDurationMs ?? durationMs,
            fetchedAt: result.value.fetchedAt ?? fetchedAt,
          });
          return;
        }
        const previousInventory = cliModelInventory[alias];
        const errorReason = extractErrorMessage(result.reason);
        const canReusePreviousModels = Boolean(
          previousInventory?.models?.length,
        );
        inventories.push({
          alias,
          models: canReusePreviousModels
            ? (previousInventory?.models ?? [])
            : [],
          source: canReusePreviousModels ? "cache" : "fallback",
          reason: canReusePreviousModels
            ? `${errorReason} | served previous UI cache`
            : errorReason,
          stale: canReusePreviousModels,
          lastUpdatedAt: fetchedAt,
          providerMode: previousInventory?.providerMode,
          fetchDurationMs: durationMs,
          fetchedAt,
        });
        if (alias === "opencode") {
          opencodeFailure = errorReason;
        }
      });

      if (inventories.length > 0) {
        setCliModelInventory((previous) => {
          const next = { ...previous };
          inventories.forEach((inventory) => {
            next[inventory.alias] = inventory;
          });
          return next;
        });
      }

      if (targets.includes("opencode")) {
        if (opencodeFailure) {
          setOpencodeModels([]);
          setOpencodeModelsError(opencodeFailure);
        } else {
          const opencodeInventory = inventories.find(
            (inventory) => inventory.alias === "opencode",
          );
          if (opencodeInventory) {
            const deduped = Array.from(
              new Set(
                opencodeInventory.models
                  .map((model) => model.trim())
                  .filter(Boolean),
              ),
            );
            setOpencodeModels(deduped);
            setOpencodeModelsError(opencodeInventory.reason ?? null);
          }
        }
      }
    } finally {
      setCliModelInventoryLoaded((previous) => {
        const next = { ...previous };
        targets.forEach((alias) => {
          next[alias] = true;
        });
        return next;
      });
      setCliModelInventoryLoading((previous) => {
        const next = { ...previous };
        targets.forEach((alias) => {
          next[alias] = false;
        });
        return next;
      });
    }
  }

  async function handleRefreshOpencodeModels() {
    if (!hasAnyOpencodeAgent) {
      setOpencodeModels([]);
      setOpencodeModelsError(null);
      return;
    }
    setOpencodeModelsLoading(true);
    setOpencodeModelsError(null);
    try {
      await refreshCliModelInventory(["opencode"], { forceRefresh: true });
    } finally {
      setOpencodeModelsLoading(false);
    }
  }

  function buildRuntimeSummary(
    mode: "phase12" | "phase3",
    includeJudge: boolean,
  ): string {
    const judgeModelLabel = withTrimmed(judgeModel) || "auto";
    const base =
      mode === "phase12"
        ? `phase1/2=${phase12AgentsSafe.map((agent) => `${agent.id}:${agent.cli}`).join(",")}`
        : `phase3=agent_a:${phase3AgentACli},agent_b:${phase3AgentBCli}`;

    const resolvedModelForAgent = (
      agentId: string,
      cli: AgentCli,
    ): string | null => {
      const scoped = withTrimmed(agentCliModels[agentId] ?? "");
      if (scoped) return scoped;
      const aliased = withTrimmed(cliModels[cli] ?? "");
      if (aliased) return aliased;
      return null;
    };
    const modelSegments: string[] = [];
    if (mode === "phase12") {
      phase12AgentsSafe.forEach((agent) => {
        const model = resolvedModelForAgent(agent.id, agent.cli);
        if (model) {
          modelSegments.push(`${agent.id}:${model}`);
        }
      });
    } else {
      const phase3AgentAModel = resolvedModelForAgent(
        "phase3_agent_a",
        phase3AgentACli,
      );
      if (phase3AgentAModel) {
        modelSegments.push(`phase3_agent_a:${phase3AgentAModel}`);
      }
      const phase3AgentBModel = resolvedModelForAgent(
        "phase3_agent_b",
        phase3AgentBCli,
      );
      if (phase3AgentBModel) {
        modelSegments.push(`phase3_agent_b:${phase3AgentBModel}`);
      }
    }

    const modelSegment =
      modelSegments.length > 0 ? ` · model=${modelSegments.join(",")}` : "";
    if (!includeJudge) return `${base}${modelSegment}`;
    return `${base}${modelSegment} · judge=${judgeProvider}:${judgeModelLabel}`;
  }

  function cliMismatch(agent: CliResolutionDiagnostic): boolean {
    if (agent.resolvedFamily === "unknown") return false;
    return agent.selectedCli !== agent.resolvedFamily;
  }

  function expectedPhase12CliForDiagnostic(
    agent: CliResolutionDiagnostic,
    index: number,
  ): AgentCli | undefined {
    return (
      phase12AgentsSafe.find((candidate) => candidate.id === agent.id)?.cli ??
      phase12AgentsSafe[index]?.cli
    );
  }

  function selectionMismatchEntries(
    diagnostic: Phase12RuntimeDiagnostic,
  ): Array<{
    label: string;
    expected: AgentCli;
    received: AgentCli;
  }> {
    const entries: Array<{
      label: string;
      expected: AgentCli;
      received: AgentCli;
    }> = [];
    diagnostic.agents.forEach((agent, index) => {
      const expected = expectedPhase12CliForDiagnostic(agent, index);
      if (!expected) return;
      if (expected !== agent.selectedCli) {
        entries.push({
          label: agent.label,
          expected,
          received: agent.selectedCli,
        });
      }
    });
    return entries;
  }

  function formatPhase12MismatchError(
    diagnostic: Phase12RuntimeDiagnostic,
  ): string {
    const mismatches = diagnostic.agents.filter(cliMismatch);
    if (mismatches.length === 0) {
      return "Phase 1/2 runtime mismatch detected.";
    }

    const details = mismatches
      .map((agent) => {
        return `${agent.label}: selected ${agent.selectedCli}, resolved ${agent.resolvedFamily} via ${agent.resolvedCommandSource} ('${agent.resolvedCommand}')`;
      })
      .join(" | ");

    return `Blocked before run: selected Phase 1/2 CLI does not match resolved executable family. ${details}`;
  }

  function formatPhase12SelectionMismatchError(
    mismatches: Array<{
      label: string;
      expected: AgentCli;
      received: AgentCli;
    }>,
  ): string {
    if (mismatches.length === 0) {
      return "Phase 1/2 IPC mapping mismatch detected.";
    }
    const details = mismatches
      .map(
        (item) =>
          `${item.label}: UI selected ${item.expected}, backend received ${item.received}`,
      )
      .join(" | ");
    return `Blocked before run: IPC arg mapping mismatch. ${details}`;
  }

  function phase12ReadinessFailures(
    diagnostic: Phase12RuntimeDiagnostic,
  ): Array<{
    label: string;
    reason: string;
    source: string;
  }> {
    return diagnostic.agents
      .filter((agent) => agent.runtimeReady === false)
      .map((agent) => ({
        label: agent.label,
        reason:
          agent.readinessReason?.trim() ||
          "Codex auth missing in isolated runtime. Run `codex login` or choose another CLI.",
        source: agent.readinessSource ?? "none",
      }));
  }

  function formatPhase12ReadinessError(
    failures: Array<{ label: string; reason: string; source: string }>,
  ): string {
    if (failures.length === 0) {
      return "Blocked before run: runtime auth readiness failed.";
    }
    const details = failures
      .map((item) => `${item.label}: ${item.reason} (source=${item.source})`)
      .join(" | ");
    return `Blocked before run: selected Phase 1/2 CLI is not runtime-ready. ${details}`;
  }

  async function diagnosePhase12BeforeRun(): Promise<Phase12RuntimeDiagnostic> {
    try {
      const diagnostic = await diagnosePhase12Cli(runtimeSettings);
      setPhase12Diagnostics(diagnostic);
      setPhase12DiagnosticsError(null);
      return diagnostic;
    } catch (caught) {
      const message = extractErrorMessage(caught);
      setPhase12DiagnosticsError(message);
      throw new Error(`Phase 1/2 runtime diagnostics failed: ${message}`);
    }
  }

  function enforceCliSetup(step: WorkflowStep): boolean {
    if (!cliSetupRequired) return false;
    const message =
      "CLI setup is required before the first run. Confirm Agent A/B in Settings.";
    setError(message);
    appendError(message, step);
    setSettingsOpen(true);
    return true;
  }

  async function handleRequirementStep(input: string) {
    if (enforceCliSetup("requirement")) {
      return;
    }

    const issue = validateRequirement(input);
    if (issue) {
      appendError(issue, "requirement");
      appendTask(
        "Send a longer problem statement",
        "requirement",
        undefined,
        SUGGESTION_SETS.requirement,
      );
      return;
    }

    setError(null);
    setSaveStatus(null);
    setPhase3FormError(null);
    setRequirement(input);
    setClarifications("");
    setDecision("");
    setFrictionInboxDraft(null);
    setPhase1Result(null);
    setPhase2Result(null);
    setPhase3Result(null);
    setProofModeOpen(false);
    setUnsavedState({
      phase1Dirty: true,
      phase2Dirty: false,
      phase3Dirty: false,
    });

    let runtimeDiagnostic: Phase12RuntimeDiagnostic | null = null;
    try {
      runtimeDiagnostic = await diagnosePhase12BeforeRun();
    } catch (caught) {
      const message = extractErrorMessage(caught);
      setError(message);
      appendError(message, "requirement");
      return;
    }

    const selectionMismatches = selectionMismatchEntries(runtimeDiagnostic);
    if (selectionMismatches.length > 0) {
      const message = formatPhase12SelectionMismatchError(selectionMismatches);
      setError(message);
      appendError(message, "requirement");
      setSettingsOpen(true);
      return;
    }

    if (runtimeDiagnostic.agents.some(cliMismatch)) {
      const message = formatPhase12MismatchError(runtimeDiagnostic);
      setError(message);
      appendError(message, "requirement");
      setSettingsOpen(true);
      return;
    }

    const readinessFailures = phase12ReadinessFailures(runtimeDiagnostic);
    if (readinessFailures.length > 0) {
      const message = formatPhase12ReadinessError(readinessFailures);
      setError(message);
      appendError(message, "requirement");
      setSettingsOpen(true);
      return;
    }

    appendStatus(
      "Runtime",
      "requirement",
      buildRuntimeSummary("phase12", false),
      false,
    );
    appendStatus(
      "Running phase 1",
      "requirement",
      "Generating multi-agent interpretations…",
      true,
    );
    const phase1StreamRequestId = startCliTimelineRun(1, "requirement");
    setPhase1Loading(true);

    try {
      const result = await runPhase1(input, runtimeSettings, {
        streamRequestId: phase1StreamRequestId,
      });
      const resultAgents = phase1AgentsFromResult(result, phase12AgentsSafe);
      const nextFrictionDraft = createFrictionInboxDraft(result);
      setPhase1Result(result);
      setFrictionInboxDraft(nextFrictionDraft);
      setUnsavedState((prev) => ({ ...prev, phase1Dirty: false }));
      finalizeCliTimelineRun(phase1StreamRequestId, "finished");

      transitionWorkflow("friction");

      appendText(
        "assistant",
        buildPhase1CompletionMessage(result, resultAgents),
        "friction",
      );
      appendConversation({
        id: crypto.randomUUID(),
        type: "friction_phase1",
        payload: {
          phase: 1,
          phase1: result,
          meta: metaFor("friction"),
        },
      });
      window.setTimeout(() => {
        void persistSessionSnapshot({ silent: true, status: "friction" });
      }, 0);
    } catch (caught) {
      const message = extractErrorMessage(caught);
      finalizeCliTimelineRun(phase1StreamRequestId, "failed", message);
      setError(`Phase 1 failed: ${message}`);
      appendError(`Phase 1 failed: ${message}`, "requirement");
      if (!runtimeDiagnostic) {
        void diagnosePhase12BeforeRun().catch(() => {
          // ignore diagnostics fallback errors in phase failure path
        });
      }
    } finally {
      setPhase1Loading(false);
    }
  }

  async function handleClarificationsStep(
    input: string,
    draftOverride?: FrictionInboxDraft,
  ) {
    if (!phase1Result || !requirement) {
      appendError("Analyze the problem statement first.", "friction");
      transitionWorkflow("requirement");
      return;
    }

    const issue = validateClarifications(input);
    if (issue) {
      appendError(issue, "friction");
      return;
    }

    const effectiveDraft = reconcileFrictionInboxDraft(
      phase1Result,
      draftOverride ?? frictionInboxDraft,
    );
    const topDisagreements = deriveTopDisagreements(phase1Result);

    setError(null);
    setSaveStatus(null);
    setClarifications(input);
    setUnsavedState((prev) => ({ ...prev, phase2Dirty: true }));
    if (draftOverride) {
      setFrictionInboxDraft(effectiveDraft);
    }

    let runtimeDiagnostic: Phase12RuntimeDiagnostic | null = null;
    try {
      runtimeDiagnostic = await diagnosePhase12BeforeRun();
    } catch (caught) {
      const message = extractErrorMessage(caught);
      setError(message);
      appendError(message, "friction");
      return;
    }

    const selectionMismatches = selectionMismatchEntries(runtimeDiagnostic);
    if (selectionMismatches.length > 0) {
      const message = formatPhase12SelectionMismatchError(selectionMismatches);
      setError(message);
      appendError(message, "friction");
      setSettingsOpen(true);
      return;
    }

    if (runtimeDiagnostic.agents.some(cliMismatch)) {
      const message = formatPhase12MismatchError(runtimeDiagnostic);
      setError(message);
      appendError(message, "friction");
      setSettingsOpen(true);
      return;
    }

    const readinessFailures = phase12ReadinessFailures(runtimeDiagnostic);
    if (readinessFailures.length > 0) {
      const message = formatPhase12ReadinessError(readinessFailures);
      setError(message);
      appendError(message, "friction");
      setSettingsOpen(true);
      return;
    }

    appendStatus(
      "Runtime",
      "friction",
      buildRuntimeSummary("phase12", false),
      false,
    );
    appendStatus(
      "Running phase 2",
      "friction",
      "Synthesizing the action brief in background…",
      true,
    );
    const phase2StreamRequestId = startCliTimelineRun(2, "friction");
    setPhase2Loading(true);

    try {
      const result = await runPhase2(requirement, input, runtimeSettings, {
        streamRequestId: phase2StreamRequestId,
      });
      const resultPlans = phase2AgentsFromResult(result, phase12AgentsSafe);
      const executionBrief = synthesizeExecutionBrief(
        resultPlans,
        effectiveDraft,
        topDisagreements,
      );
      const humanDecision = buildDecisionFromBrief(executionBrief);
      const humanDecisionStructured = buildHumanDecisionStructuredFromBrief(
        executionBrief,
        resultPlans,
      );
      const submittedDraft: FrictionInboxDraft = {
        ...effectiveDraft,
        status: "submitted",
      };
      const updatedResult: Phase2Result = {
        ...result,
        humanDecision,
        humanDecisionStructured,
        executionBrief,
        actionBrief: executionBrief,
      };

      setDecision(humanDecision);
      setPhase2Result(updatedResult);
      setFrictionInboxDraft(submittedDraft);
      setUnsavedState((prev) => ({ ...prev, phase2Dirty: false }));
      finalizeCliTimelineRun(phase2StreamRequestId, "finished");

      transitionWorkflow("brief");
      setConversation((previous) =>
        previous.filter((item) => item.type !== "execution_brief"),
      );

      appendText(
        "assistant",
        buildExecutionBriefReadyMessage(executionBrief),
        "brief",
      );
      appendConversation({
        id: crypto.randomUUID(),
        type: "execution_brief",
        payload: {
          phase: 2,
          brief: executionBrief,
          meta: metaFor("brief"),
        },
      });
      window.setTimeout(() => {
        void persistSessionSnapshot({ silent: true, status: "brief_ready" });
      }, 0);
    } catch (caught) {
      const message = extractErrorMessage(caught);
      finalizeCliTimelineRun(phase2StreamRequestId, "failed", message);
      setError(`Phase 2 failed: ${message}`);
      appendError(`Phase 2 failed: ${message}`, "friction");
      if (!runtimeDiagnostic) {
        void diagnosePhase12BeforeRun().catch(() => {
          // ignore diagnostics fallback errors in phase failure path
        });
      }
    } finally {
      setPhase2Loading(false);
    }
  }

  async function handlePhase3Step() {
    if (!phase2Result || !requirement || !clarifications || !decision) {
      appendError(
        "Complete the action brief before running proof mode.",
        "brief",
      );
      return;
    }

    const trimmedRepoPath = withTrimmed(repoPath);
    if (trimmedRepoPath.length < 3) {
      const message = "Repository path is required.";
      setPhase3FormError(message);
      appendError(message, "brief");
      focusComposerInput();
      return;
    }

    setPhase3FormError(null);
    setError(null);
    setSaveStatus(null);
    setRepoPath(trimmedRepoPath);
    setProofModeOpen(true);
    setUnsavedState((prev) => ({ ...prev, phase3Dirty: true }));

    transitionWorkflow("phase3_run");
    appendStatus(
      "Runtime",
      "phase3_run",
      buildRuntimeSummary("phase3", true),
      false,
    );
    appendStatus(
      "Running proof mode",
      "phase3_run",
      "Executing repo-backed proof checks…",
      true,
    );
    const phase3StreamRequestId = startCliTimelineRun(3, "phase3_run");
    setPhase3Loading(true);

    try {
      const result = await runPhase3Adversarial(
        {
          repoPath: trimmedRepoPath,
          baseBranch: withTrimmed(baseBranch) || "main",
          requirement,
          clarifications,
          decision,
          judgeProvider,
          judgeModel: withTrimmed(judgeModel),
          runtimeSettings,
          autoCleanup,
        },
        {
          streamRequestId: phase3StreamRequestId,
        },
      );

      setPhase3Result(result);
      setUnsavedState((prev) => ({ ...prev, phase3Dirty: false }));
      finalizeCliTimelineRun(phase3StreamRequestId, "finished");
      transitionWorkflow("brief");
      setConversation((previous) =>
        previous.filter((item) => item.type !== "code"),
      );

      appendText(
        "assistant",
        "Proof mode completed. Review the repo findings against the action brief.",
        "brief",
      );
      appendConversation({
        id: crypto.randomUUID(),
        type: "code",
        payload: {
          phase: 3,
          phase3: result,
          repoPath: trimmedRepoPath,
          baseBranch: withTrimmed(baseBranch) || "main",
          meta: metaFor("brief"),
        },
      });
      window.setTimeout(() => {
        void persistSessionSnapshot({ silent: true, status: "proof_ready" });
      }, 0);
    } catch (caught) {
      const message = extractErrorMessage(caught);
      finalizeCliTimelineRun(phase3StreamRequestId, "failed", message);
      const fullMessage = `Proof mode failed: ${message}`;
      setPhase3FormError(fullMessage);
      setError(fullMessage);
      appendError(fullMessage, "brief");
      transitionWorkflow("brief");
    } finally {
      setPhase3Loading(false);
    }
  }

  async function submitWorkflowInput(input: string) {
    if (isBusy) return;

    const normalizedInput = withTrimmed(input);
    if (!normalizedInput) return;

    const step = workflowStep;
    if (step === "friction") {
      appendText(
        "assistant",
        "Step 2 is friction-only. Use the inline card to resolve the top disagreements, then generate the brief.",
        "friction",
      );
      return;
    }

    if (step === "brief") {
      appendText(
        "assistant",
        "The action brief is already ready. Use the inline brief card to export it, or open proof mode if you want repo evidence.",
        "brief",
      );
      return;
    }

    appendText("user", normalizedInput, step);

    if (step === "requirement") {
      await handleRequirementStep(normalizedInput);
      return;
    }
  }

  async function handleComposerSubmit() {
    if (isBusy) return;
    const input = withTrimmed(composerText);
    if (!input) return;
    setComposerText("");
    await submitWorkflowInput(input);
  }

  function ensureActiveSessionIdentity(
    problemStatement = activeProblemStatement,
  ) {
    if (
      !hasMeaningfulSessionContent &&
      nonWhitespaceLength(problemStatement) < AUTOSAVE_MIN_NON_WHITESPACE
    ) {
      return null;
    }

    const existingId = currentSessionId ?? routeState.sessionId;
    const existingCreatedAt = currentSessionCreatedAt;
    if (existingId && existingCreatedAt) {
      return { id: existingId, createdAt: existingCreatedAt };
    }

    const nextId = existingId ?? crypto.randomUUID();
    const nextCreatedAt = existingCreatedAt ?? new Date().toISOString();
    setCurrentSessionId(nextId);
    setCurrentSessionCreatedAt(nextCreatedAt);
    updateRoute(
      (prev) => ({
        ...prev,
        sessionId: nextId,
      }),
      "replace",
    );
    return { id: nextId, createdAt: nextCreatedAt };
  }

  function buildSnapshot(options?: {
    updatedAt?: string;
    status?: SessionStatus;
  }) {
    const identity = ensureActiveSessionIdentity();
    if (!identity) return null;

    return buildSessionExport({
      id: identity.id,
      createdAt: identity.createdAt,
      updatedAt: options?.updatedAt ?? new Date().toISOString(),
      problemStatement: activeProblemStatement,
      requirement,
      workflowStep,
      composerText,
      conversationItems: conversation,
      frictionInboxDraft,
      proofMode: {
        open: proofModeOpen,
        repoPath,
        baseBranch,
        consentedToDataset,
      },
      phase1: phase1Result
        ? { ...phase1Result, humanClarifications: withTrimmed(clarifications) }
        : null,
      phase2: phase2Result
        ? {
          ...phase2Result,
          humanDecision: withTrimmed(decision),
        }
        : null,
      phase3: phase3Result ?? null,
      consentedToDataset,
      runtimeSettings,
      appVersion: APP_VERSION,
      status: options?.status,
    });
  }

  async function persistSessionSnapshot(options?: {
    silent?: boolean;
    status?: SessionStatus;
  }) {
    const snapshot = buildSnapshot({
      updatedAt: new Date().toISOString(),
      status: options?.status,
    });
    if (!snapshot) return null;

    try {
      const id = await saveSessionRecord(snapshot);
      setCurrentSessionId(snapshot.id);
      setCurrentSessionCreatedAt(snapshot.metadata.timestamp);
      await refreshRecentSessions();
      setUnsavedState({
        phase1Dirty: false,
        phase2Dirty: false,
        phase3Dirty: false,
      });
      if (!options?.silent) {
        const message = `Session snapshot saved (${id.slice(0, 8)}...).`;
        setSaveStatus(message);
        appendStatus("Snapshot saved", workflowStep, message, false);
      }
      return id;
    } catch (caught) {
      const message = extractErrorMessage(caught);
      if (!options?.silent) {
        const fullMessage = `Snapshot failed: ${message}`;
        setSaveStatus(fullMessage);
        appendError(fullMessage, workflowStep);
      }
      return null;
    }
  }

  function handleExportSession() {
    const snapshot = buildSnapshot();
    if (!snapshot) {
      const message = "Write a longer problem statement before exporting.";
      setSaveStatus(message);
      appendError(message, workflowStep);
      return;
    }

    downloadSession(snapshot);
    const message = "Session exported to JSON.";
    setSaveStatus(message);
    appendStatus("Export complete", workflowStep, message, false);
  }

  async function handleSaveSessionLocal() {
    if (!buildSnapshot()) {
      const message =
        "Write a longer problem statement before creating a snapshot.";
      setSaveStatus(message);
      appendError(message, workflowStep);
      return;
    }

    setSaveLocalLoading(true);
    setSaveStatus(null);

    try {
      await persistSessionSnapshot({ silent: false });
    } finally {
      setSaveLocalLoading(false);
    }
  }

  async function handleExportDataset() {
    setDatasetLoading(true);
    setSaveStatus(null);
    setError(null);

    try {
      const result = await exportConsentedDataset();
      const message = `Dataset exported (${result.count} sessions): ${result.path}`;
      setSaveStatus(message);
      appendStatus("Dataset export complete", workflowStep, message, false);
    } catch (caught) {
      const message = extractErrorMessage(caught);
      const fullMessage = `Dataset export failed: ${message}`;
      setError(fullMessage);
      appendError(fullMessage, workflowStep);
    } finally {
      setDatasetLoading(false);
    }
  }

  function buildConversationFromSession(
    session: FrictionSession,
    loadedPhase1: Phase1Result | null,
    loadedPhase2: Phase2Result | null,
    loadedPhase3: Phase3Result,
    nextStep: WorkflowStep,
  ): ConversationItem[] {
    if (session.conversation_items && session.conversation_items.length > 0) {
      return session.conversation_items;
    }

    const sessionProblem = withTrimmed(
      session.problem_statement ?? session.requirement,
    );
    const items: ConversationItem[] = [
      {
        id: crypto.randomUUID(),
        type: "assistant",
        text: `Session ${session.id.slice(0, 8)} loaded.`,
        meta: metaFor(nextStep),
      },
    ];

    if (sessionProblem) {
      items.push({
        id: crypto.randomUUID(),
        type: "user",
        text: sessionProblem,
        meta: metaFor("requirement"),
      });
    }

    if (loadedPhase1 && !loadedPhase2) {
      items.push({
        id: crypto.randomUUID(),
        type: "friction_phase1",
        payload: {
          phase: 1,
          phase1: loadedPhase1,
          meta: metaFor("friction"),
        },
      });
    }

    if (loadedPhase2 && !loadedPhase2.executionBrief) {
      const phase2Plans = phase2AgentsFromResult(
        loadedPhase2,
        phase12AgentsSafe,
      );
      loadedPhase2.executionBrief = synthesizeExecutionBriefFromLegacyDecision(
        loadedPhase2,
        phase2Plans,
        loadedPhase1?.humanClarifications ?? "",
      );
    }

    const restoredBrief =
      loadedPhase2?.executionBrief ??
      loadedPhase2?.actionBrief ??
      session.result?.action_brief ??
      session.result?.execution_brief;
    if (restoredBrief) {
      items.push({
        id: crypto.randomUUID(),
        type: "execution_brief",
        payload: {
          phase: 2,
          brief: restoredBrief as ExecutionBrief,
          meta: metaFor("brief"),
        },
      });
    }

    if (
      loadedPhase3.codeA ||
      loadedPhase3.codeB ||
      loadedPhase3.attackReport.length > 0
    ) {
      items.push({
        id: crypto.randomUUID(),
        type: "code",
        payload: {
          phase: 3,
          phase3: loadedPhase3,
          repoPath: repoPath || "loaded-session",
          baseBranch: baseBranch || "main",
          meta: metaFor("brief"),
        },
      });
    }

    return items;
  }

  function buildConversationFromDraft(
    draft: WorkflowDraft,
  ): ConversationItem[] {
    const draftStep = normalizeWorkflowStep(draft.workflowStep);
    const items: ConversationItem[] = [
      {
        id: crypto.randomUUID(),
        type: "assistant",
        text: `Draft restored (auto-saved ${formatDateTime(draft.savedAt)}).`,
        meta: metaFor(draftStep),
      },
      {
        id: crypto.randomUUID(),
        type: "user",
        text: draft.requirement,
        meta: metaFor("requirement"),
      },
    ];

    if (draft.phase1Result) {
      if (!draft.phase2Result) {
        items.push({
          id: crypto.randomUUID(),
          type: "friction_phase1",
          payload: {
            phase: 1,
            phase1: draft.phase1Result,
            meta: metaFor("friction"),
          },
        });
      }
    }

    if (draft.phase2Result) {
      const phase2Result =
        draft.phase2Result.actionBrief || draft.phase2Result.executionBrief
          ? draft.phase2Result
          : {
            ...draft.phase2Result,
            executionBrief: synthesizeExecutionBriefFromLegacyDecision(
              draft.phase2Result,
              phase2AgentsFromResult(draft.phase2Result, phase12AgentsSafe),
              draft.frictionInboxDraft?.contextNote ?? draft.clarifications,
            ),
          };
      if (phase2Result.executionBrief && !phase2Result.actionBrief) {
        phase2Result.actionBrief = phase2Result.executionBrief;
      }

      items.push({
        id: crypto.randomUUID(),
        type: "execution_brief",
        payload: {
          phase: 2,
          brief: (phase2Result.actionBrief ??
            phase2Result.executionBrief) as ExecutionBrief,
          meta: metaFor("brief"),
        },
      });
    }

    items.push({
      id: crypto.randomUUID(),
      type: "task",
      payload: {
        title: "Draft restored — continue where you left off",
        description: `Step: ${draftStep}`,
        suggestions: SUGGESTION_SETS[draftStep],
        done: false,
        meta: metaFor(draftStep),
      },
    });

    return items;
  }

  function hydrateFromSession(session: FrictionSession) {
    const sessionProblem = withTrimmed(
      session.problem_statement ?? session.requirement,
    );
    const phase1Log = session.phase1 ?? null;
    const phase2Log = session.phase2 ?? null;
    const runtimePhase12Agents = phase12AgentsFromRuntime(
      session.metadata.runtime,
    );
    const runtimePhase3 = phase3CliFromRuntime(
      session.metadata.runtime,
      runtimePhase12Agents,
    );
    const [phase1Architect, phase1Pragmatist] =
      phase1Log?.interpretations ?? [];
    const [phase2Architect, phase2Pragmatist] = phase2Log?.plans ?? [];

    const loadedPhase1: Phase1Result | null =
      phase1Log && (phase1Architect || phase1Pragmatist)
        ? {
          architect: phase1Architect ?? phase1Pragmatist,
          pragmatist: phase1Pragmatist ?? phase1Architect,
          agentResponses: phase1Log.interpretations.map((response, index) => {
            const agent = runtimePhase12Agents[index] ?? {
              id: `agent_${index + 1}`,
              label: `Agent ${index + 1}`,
              cli: DEFAULT_AGENT_A_CLI,
            };
            return {
              id: agent.id,
              label: agent.label,
              cli: agent.cli,
              response,
            };
          }),
          divergences: phase1Log.divergences,
          humanClarifications: phase1Log.human_clarifications,
        }
        : null;

    const loadedPhase2: Phase2Result | null =
      phase2Log && (phase2Architect || phase2Pragmatist)
        ? {
          architect: phase2Architect ?? phase2Pragmatist,
          pragmatist: phase2Pragmatist ?? phase2Architect,
          agentPlans: phase2Log.plans.map((plan, index) => {
            const agent = runtimePhase12Agents[index] ?? {
              id: `agent_${index + 1}`,
              label: `Agent ${index + 1}`,
              cli: DEFAULT_AGENT_A_CLI,
            };
            return {
              id: agent.id,
              label: agent.label,
              cli: agent.cli,
              plan,
            };
          }),
          divergences: phase2Log.divergences,
          humanDecision: phase2Log.human_decision,
          humanDecisionStructured: phase2Log.human_decision_structured,
          executionBrief:
            phase2Log.execution_brief ??
            phase2Log.action_brief ??
            session.result?.action_brief ??
            session.result?.execution_brief,
          actionBrief:
            phase2Log.action_brief ??
            phase2Log.execution_brief ??
            session.result?.action_brief ??
            session.result?.execution_brief,
        }
        : null;

    if (loadedPhase2 && !loadedPhase2.executionBrief) {
      loadedPhase2.executionBrief = synthesizeExecutionBriefFromLegacyDecision(
        loadedPhase2,
        phase2AgentsFromResult(loadedPhase2, runtimePhase12Agents),
        loadedPhase1?.humanClarifications ?? "",
      );
      loadedPhase2.actionBrief = loadedPhase2.executionBrief;
    }
    if (
      loadedPhase2 &&
      !loadedPhase2.humanDecisionStructured &&
      loadedPhase2.executionBrief
    ) {
      loadedPhase2.humanDecisionStructured =
        buildHumanDecisionStructuredFromBrief(
          loadedPhase2.executionBrief as ExecutionBrief,
          phase2AgentsFromResult(loadedPhase2, runtimePhase12Agents),
        );
    }
    if (
      loadedPhase2 &&
      !withTrimmed(loadedPhase2.humanDecision) &&
      loadedPhase2.executionBrief
    ) {
      loadedPhase2.humanDecision = buildDecisionFromBrief(
        loadedPhase2.executionBrief as ExecutionBrief,
      );
    }

    const loadedPhase3: Phase3Result = session.phase3
      ? {
        codeA: session.phase3.code_a,
        codeB: session.phase3.code_b,
        attackReport: session.phase3.attack_report,
        confidenceScore: session.phase3.confidence_score,
        adrPath: session.phase3.adr_path,
        adrMarkdown: session.phase3.adr_markdown,
        workflowMode: session.metadata.workflow_mode,
      }
      : placeholderPhase3();

    setCurrentSessionId(session.id);
    setCurrentSessionCreatedAt(session.metadata.timestamp);
    setComposerText(session.working_state?.composerText ?? "");
    setRequirement(sessionProblem);
    setClarifications(loadedPhase1?.humanClarifications ?? "");
    setDecision(loadedPhase2?.humanDecision ?? "");
    setFrictionInboxDraft(session.working_state?.frictionDraft ?? null);
    setPhase12Agents(runtimePhase12Agents);
    setPhase3AgentACli(runtimePhase3.agentA);
    setPhase3AgentBCli(runtimePhase3.agentB);
    setPhase1Result(loadedPhase1);
    setPhase2Result(loadedPhase2);
    setPhase3Result(
      loadedPhase3.codeA ||
        loadedPhase3.codeB ||
        loadedPhase3.attackReport.length > 0
        ? loadedPhase3
        : null,
    );
    setRepoPath(session.working_state?.proofMode?.repoPath ?? "");
    setBaseBranch(session.working_state?.proofMode?.baseBranch ?? "main");
    setProofModeOpen(session.working_state?.proofMode?.open ?? false);
    setConsentedToDataset(session.metadata.consented_to_dataset);

    if (session.metadata.runtime) {
      const runtime = session.metadata.runtime;
      setJudgeProvider(ensureJudgeProvider(runtime.judge.provider));
      setJudgeModel(runtime.judge.model);
      setOllamaHost(runtime.ollama_host ?? "http://localhost:11434");
      setCliModels(normalizeCliModels(runtime.cli_models));
      setAgentCliModels(normalizeAgentCliModels(runtime.agent_cli_models));
    }

    const nextStep: WorkflowStep =
      session.working_state?.currentStep === "phase3_run"
        ? "phase3_run"
        : loadedPhase2?.executionBrief
          ? "brief"
          : loadedPhase1
            ? "friction"
            : "requirement";
    setWorkflowStep(nextStep);
    setConversation(
      buildConversationFromSession(
        session,
        loadedPhase1,
        loadedPhase2,
        loadedPhase3,
        nextStep,
      ),
    );
    setUnsavedState({
      phase1Dirty: false,
      phase2Dirty: false,
      phase3Dirty: false,
    });

    updateRoute(
      () => ({
        phase: phaseFromStep(nextStep),
        sessionId: session.id,
      }),
      "replace",
    );

    setSaveStatus(`Session ${session.id.slice(0, 8)} loaded.`);
  }

  async function performLoadSession(id: string) {
    setSaveStatus(null);
    setError(null);
    resetCliTimelineRuns();
    isHydratingSessionRef.current = true;

    try {
      const session = await loadSessionRecord(id);
      if (!session) {
        setSaveStatus("Session not found.");
        appendError("Session not found.", workflowStep);
        return;
      }
      hydrateFromSession(session);
    } catch (caught) {
      const message = extractErrorMessage(caught);
      const fullMessage = `Load failed: ${message}`;
      setError(fullMessage);
      appendError(fullMessage, workflowStep);
    } finally {
      isHydratingSessionRef.current = false;
    }
  }

  function handleLoadSession(id: string) {
    if (currentSessionId !== id) {
      void persistSessionSnapshot({ silent: true });
    }
    guardUnsaved(
      () => {
        updateRoute((prev) => ({ ...prev, sessionId: id }), "push");
      },
      {
        title: "Discard unsaved changes?",
        description:
          "Loading another session will replace current input values.",
        confirmLabel: "Discard and load",
      },
    );
  }

  function restartNow() {
    resetCliTimelineRuns();
    setComposerText("");
    setCurrentSessionId(null);
    setCurrentSessionCreatedAt(null);
    setRequirement("");
    setClarifications("");
    setDecision("");
    setFrictionInboxDraft(null);
    setPhase1Result(null);
    setPhase2Result(null);
    setPhase3Result(null);
    setRepoPath("");
    setBaseBranch("main");
    setProofModeOpen(false);
    setConsentedToDataset(false);
    setSaveStatus(null);
    setError(null);
    setPhase3FormError(null);
    setConversation(makeInitialConversation());
    setUnsavedState({
      phase1Dirty: false,
      phase2Dirty: false,
      phase3Dirty: false,
    });
    transitionWorkflow("requirement", "push");
    updateRoute(() => ({ ...DEFAULT_ROUTE_STATE }), "replace");
  }

  function handleRestart() {
    guardUnsaved(restartNow, {
      title: "Start a new session?",
      description: "This clears the current workflow state.",
      confirmLabel: "Start new",
    });
  }

  function handleSuggestionPick(suggestion: string) {
    if (suggestion === "Create snapshot") {
      void handleSaveSessionLocal();
      return;
    }

    if (suggestion === "Export session") {
      handleExportSession();
      return;
    }

    if (suggestion === "Export consented dataset") {
      void handleExportDataset();
      return;
    }

    if (suggestion === "New session") {
      handleRestart();
      return;
    }

    setComposerText(suggestion);
    focusComposerInput();
  }

  const flushPendingCliTimelineEvents = useCallback(() => {
    const pending = pendingCliEventsRef.current;
    if (pending.length === 0) {
      return;
    }
    pendingCliEventsRef.current = [];

    setCliTimelineRuns((previous) => {
      let nextRuns = previous;
      for (const payload of pending) {
        const requestId = payload.requestId;
        const isActive = activeCliTimelineRequestIdsRef.current.has(requestId);
        const hasRun = nextRuns.some((run) => run.requestId === requestId);
        if (!isActive && !hasRun) {
          continue;
        }
        nextRuns = applyCliCommandLogEvent(nextRuns, payload);
        if (payload.kind === "run_finished" || payload.kind === "run_failed") {
          activeCliTimelineRequestIdsRef.current.delete(requestId);
        }
      }
      return nextRuns;
    });
  }, []);

  const enqueueCliTimelineEvent = useCallback(
    (payload: CliCommandLogEvent) => {
      pendingCliEventsRef.current.push(payload);
      const shouldFlushImmediately =
        payload.kind !== "command_chunk" ||
        pendingCliEventsRef.current.length >=
        CLI_TIMELINE_EVENT_IMMEDIATE_FLUSH_THRESHOLD;
      if (shouldFlushImmediately) {
        if (cliEventFlushTimerRef.current !== null) {
          window.clearTimeout(cliEventFlushTimerRef.current);
          cliEventFlushTimerRef.current = null;
        }
        flushPendingCliTimelineEvents();
        return;
      }
      if (cliEventFlushTimerRef.current !== null) {
        return;
      }
      cliEventFlushTimerRef.current = window.setTimeout(() => {
        cliEventFlushTimerRef.current = null;
        flushPendingCliTimelineEvents();
      }, CLI_TIMELINE_EVENT_FLUSH_MS);
    },
    [flushPendingCliTimelineEvents],
  );

  useEffect(() => {
    void refreshRecentSessions();

    // Restore draft if one exists and no explicit session is being loaded via URL
    if (!readRouteStateFromLocation().sessionId) {
      const draft = readDraft();
      if (draft && draft.requirement && draft.phase1Result) {
        const nextFrictionDraft = draft.phase2Result
          ? null
          : reconcileFrictionInboxDraft(
            draft.phase1Result,
            draft.frictionInboxDraft ?? null,
          );
        const nextPhase2Result = draft.phase2Result
          ? draft.phase2Result.executionBrief
            ? draft.phase2Result
            : (() => {
              const phase2Plans = phase2AgentsFromResult(
                draft.phase2Result,
                phase12AgentsSafe,
              );
              const executionBrief =
                synthesizeExecutionBriefFromLegacyDecision(
                  draft.phase2Result,
                  phase2Plans,
                  draft.frictionInboxDraft?.contextNote ??
                  draft.clarifications,
                );
              return {
                ...draft.phase2Result,
                executionBrief,
                humanDecisionStructured:
                  draft.phase2Result.humanDecisionStructured ??
                  buildHumanDecisionStructuredFromBrief(
                    executionBrief,
                    phase2Plans,
                  ),
                humanDecision:
                  withTrimmed(draft.phase2Result.humanDecision) ||
                  buildDecisionFromBrief(executionBrief),
              };
            })()
          : null;
        const restoredStep: WorkflowStep = nextPhase2Result
          ? normalizeWorkflowStep(draft.workflowStep)
          : "friction";
        const nextDecision =
          nextPhase2Result?.humanDecision &&
            withTrimmed(nextPhase2Result.humanDecision)
            ? nextPhase2Result.humanDecision
            : nextPhase2Result?.executionBrief
              ? buildDecisionFromBrief(nextPhase2Result.executionBrief)
              : draft.decision;
        setRequirement(draft.requirement);
        if (draft.clarifications) setClarifications(draft.clarifications);
        if (nextDecision) setDecision(nextDecision);
        setFrictionInboxDraft(nextFrictionDraft);
        setPhase1Result(draft.phase1Result);
        if (nextPhase2Result) setPhase2Result(nextPhase2Result);
        setWorkflowStep(restoredStep);
        setConversation(
          buildConversationFromDraft({
            ...draft,
            decision: nextDecision,
            phase2Result: nextPhase2Result,
            frictionInboxDraft: nextFrictionDraft,
            workflowStep: restoredStep,
          }),
        );
      }
    }
  }, []);

  useEffect(() => {
    if (!canUseTauriCommands()) return;

    let unlisten: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) return;
        unlisten = await listen<CliCommandLogEvent>(
          CLI_COMMAND_LOG_EVENT_NAME,
          (event) => {
            const payload = event.payload;
            if (!isCliCommandLogEventPayload(payload)) {
              return;
            }
            enqueueCliTimelineEvent(payload);
          },
        );
      } catch {
        // Event channel unavailable in non-Tauri contexts.
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) {
        unlisten();
      }
      pendingCliEventsRef.current = [];
      if (cliEventFlushTimerRef.current !== null) {
        window.clearTimeout(cliEventFlushTimerRef.current);
        cliEventFlushTimerRef.current = null;
      }
    };
  }, [enqueueCliTimelineEvent]);

  useEffect(() => {
    if (!cliSetupRequired) {
      onboardingAutoSelectAppliedRef.current = false;
      return;
    }
    if (onboardingAutoSelectAppliedRef.current) {
      return;
    }
    onboardingAutoSelectAppliedRef.current = true;

    let cancelled = false;
    const detectionRuntimeSettings: RuntimeSettings = {
      ...runtimeSettings,
      phase12Agents: CLI_DETECTION_AGENTS,
    };

    (async () => {
      try {
        const diagnostic = await diagnosePhase12Cli(detectionRuntimeSettings);
        if (cancelled) return;

        const executableAliases = CLI_DETECTION_PRIORITY.filter((cli) => {
          const entry = diagnostic.agents.find(
            (agent) => agent.selectedCli === cli,
          );
          return Boolean(entry?.resolvedBinaryPath?.trim());
        });

        const nextPair: [AgentCli, AgentCli] =
          executableAliases.length >= 2
            ? [executableAliases[0], executableAliases[1]]
            : executableAliases.length === 1
              ? [executableAliases[0], executableAliases[0]]
              : [DEFAULT_AGENT_A_CLI, DEFAULT_AGENT_B_CLI];

        setPhase12Agents((previous) => {
          const safe = ensureAtLeastTwoPhaseAgents(previous);
          if (safe[0].cli === nextPair[0] && safe[1].cli === nextPair[1]) {
            return previous;
          }

          return safe.map((agent, index) => {
            if (index === 0) return { ...agent, cli: nextPair[0] };
            if (index === 1) return { ...agent, cli: nextPair[1] };
            return agent;
          });
        });
      } catch {
        // Keep defaults if detection fails.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [cliSetupRequired, runtimeSettings]);

  useEffect(() => {
    if (!settingsOpen && !cliSetupRequired) return;
    let cancelled = false;
    setPhase12DiagnosticsLoading(true);
    setPhase12DiagnosticsError(null);

    (async () => {
      try {
        const diagnostic = await diagnosePhase12Cli(runtimeSettings);
        if (cancelled) return;
        setPhase12Diagnostics(diagnostic);
        setPhase12DiagnosticsError(null);
      } catch (caught) {
        if (cancelled) return;
        setPhase12Diagnostics(null);
        setPhase12DiagnosticsError(extractErrorMessage(caught));
      } finally {
        if (!cancelled) {
          setPhase12DiagnosticsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [settingsOpen, cliSetupRequired, runtimeSettings]);

  useEffect(() => {
    if (!settingsOpen && !cliSetupRequired) return;
    const targets = visibleCliAliases.filter(
      (alias) =>
        !cliModelInventoryLoaded[alias] && !cliModelInventoryLoading[alias],
    );
    if (targets.length === 0) return;
    void refreshCliModelInventory(targets);
  }, [
    settingsOpen,
    cliSetupRequired,
    visibleCliAliases,
    cliModelInventoryLoaded,
    cliModelInventoryLoading,
  ]);

  useEffect(() => {
    if (visibleCliAliases.length === 0) {
      return;
    }
    if (
      lastInventoryRefreshSignatureRef.current === inventoryRefreshSignature
    ) {
      return;
    }
    lastInventoryRefreshSignatureRef.current = inventoryRefreshSignature;
    void refreshCliModelInventory(visibleCliAliases);
  }, [inventoryRefreshSignature, visibleCliAliases]);

  useEffect(() => {
    const backgroundAliases = AGENT_CLI_OPTIONS.filter(
      (alias) => !visibleCliAliases.includes(alias),
    );
    const pending = backgroundAliases.filter(
      (alias) =>
        !cliModelInventoryLoaded[alias] && !cliModelInventoryLoading[alias],
    );
    if (pending.length === 0) return;
    const timeout = window.setTimeout(() => {
      void refreshCliModelInventory(pending);
    }, 350);
    return () => window.clearTimeout(timeout);
  }, [visibleCliAliases, cliModelInventoryLoaded, cliModelInventoryLoading]);

  useEffect(() => {
    if (isHydratingSessionRef.current) return;
    if (
      !hasMeaningfulSessionContent &&
      nonWhitespaceLength(activeProblemStatement) < AUTOSAVE_MIN_NON_WHITESPACE
    ) {
      return;
    }

    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
    }

    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      void persistSessionSnapshot({ silent: true });
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => {
      if (autosaveTimerRef.current !== null) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [
    activeProblemStatement,
    baseBranch,
    composerText,
    consentedToDataset,
    conversation,
    frictionInboxDraft,
    hasMeaningfulSessionContent,
    phase1Loading,
    phase1Result,
    phase2Loading,
    phase2Result,
    phase3Loading,
    phase3Result,
    proofModeOpen,
    repoPath,
    workflowStep,
  ]);

  useEffect(() => {
    if (!routeState.sessionId || routeState.sessionId === currentSessionId)
      return;
    void performLoadSession(routeState.sessionId);
  }, [currentSessionId, routeState.sessionId]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (
        hasMeaningfulSessionContent ||
        nonWhitespaceLength(activeProblemStatement) >=
        AUTOSAVE_MIN_NON_WHITESPACE
      ) {
        void persistSessionSnapshot({ silent: true });
      }
      if (hasUnsaved) {
        event.preventDefault();
        event.returnValue = "";
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        void persistSessionSnapshot({ silent: true });
      }
    };

    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [activeProblemStatement, hasMeaningfulSessionContent, hasUnsaved]);

  // Persist settings to localStorage whenever any setting changes
  useEffect(() => {
    const settings: PersistedSettings = {
      phase12Agents: phase12AgentsSafe,
      phase3AgentACli,
      phase3AgentBCli,
      cliCommands,
      cliModels,
      agentCliModels,
      // Legacy keys kept for read compatibility with older versions.
      agentACli: phase12AgentsSafe[0]?.cli,
      agentBCli: phase12AgentsSafe[1]?.cli,
      phaseAgents: phase12AgentsSafe,
      ollamaHost,
      judgeProvider,
      judgeModel,
      phase3ReviewerCli: phase3AgentBCli,
    };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // localStorage unavailable or quota exceeded – ignore
    }
  }, [
    phase12AgentsSafe,
    phase3AgentACli,
    phase3AgentBCli,
    cliCommands,
    cliModels,
    agentCliModels,
    ollamaHost,
    judgeProvider,
    judgeModel,
  ]);

  useEffect(() => {
    const onPopState = () => {
      const next = readRouteStateFromLocation();
      setRouteState({ ...DEFAULT_ROUTE_STATE, ...next });
      if (!next.sessionId) {
        setWorkflowStep(stepFromPhase(next.phase));
      }
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const viewport = getThreadViewport();
    if (!viewport) return;
    const handleScroll = () => {
      syncThreadScrollState();
    };
    syncThreadScrollState();
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", handleScroll);
    };
  }, [
    assistantThreadMessages.length,
    getThreadViewport,
    syncThreadScrollState,
  ]);

  useEffect(() => {
    if (!threadAutoScrollRef.current) {
      return;
    }
    const behavior: ScrollBehavior = isBusy ? "auto" : "smooth";
    scrollThreadToBottom(behavior);
  }, [conversation.length, isBusy, scrollThreadToBottom]);

  useEffect(() => {
    if (!threadAutoScrollRef.current) return;
    scrollThreadToBottom("auto");
  }, [cliTimelineRuns, scrollThreadToBottom]);

  useEffect(() => {
    if (promptModelAgentIds.length === 0) return;
    if (promptModelAgentIds.includes(activePromptModelAgentId)) return;
    setActivePromptModelAgentId(promptModelAgentIds[0]);
  }, [activePromptModelAgentId, promptModelAgentIds]);
  const composerAccessory: JSX.Element | null = null;

  if (cliSetupRequired) {
    return (
      <>
        <OnboardingCliSetupScreen
          phase12Agents={phase12AgentsSafe}
          cliCommands={cliCommands}
          cliCommandStatuses={onboardingCliStatuses}
          cliDiagnosticsLoading={phase12DiagnosticsLoading}
          cliDiagnosticsError={phase12DiagnosticsError}
          canConfirmCliSetup={canConfirmCliSetup}
          onPhase12AgentsChange={setPhase12Agents}
          onCliCommandChange={handleCliCommandChange}
          onConfirmCliSetup={handleConfirmCliSetup}
          onOpenAdvancedSettings={() => setSettingsOpen(true)}
        />

        <SettingsDialog
          open={settingsOpen}
          onOpenChange={handleSettingsOpenChange}
          judgeProviderOptions={JUDGE_PROVIDER_OPTIONS}
          phase12Agents={phase12AgentsSafe}
          phase3AgentACli={phase3AgentACli}
          phase3AgentBCli={phase3AgentBCli}
          cliCommands={cliCommands}
          cliModels={cliModels}
          cliModelInventory={cliModelInventory}
          agentCliModels={agentCliModels}
          cliCommandStatuses={onboardingCliStatuses}
          opencodeModels={opencodeModels}
          opencodeModelsLoading={opencodeModelsLoading}
          opencodeModelsError={opencodeModelsError}
          cliDiagnosticsLoading={phase12DiagnosticsLoading}
          cliDiagnosticsError={phase12DiagnosticsError}
          judgeProvider={judgeProvider}
          judgeModel={judgeModel}
          ollamaHost={ollamaHost}
          autoCleanup={autoCleanup}
          onPhase12AgentsChange={setPhase12Agents}
          onPhase3AgentACliChange={setPhase3AgentACli}
          onPhase3AgentBCliChange={setPhase3AgentBCli}
          onCliCommandChange={handleCliCommandChange}
          onAgentCliModelChange={handleAgentCliModelChange}
          onCliModelChange={handleCliModelChange}
          onJudgeProviderChange={setJudgeProvider}
          onJudgeModelChange={setJudgeModel}
          onOllamaHostChange={setOllamaHost}
          onAutoCleanupChange={setAutoCleanup}
          onRefreshOpencodeModels={() => void handleRefreshOpencodeModels()}
          onRerunCliOnboarding={handleRerunCliOnboarding}
          onResetRuntimeSettings={handleResetRuntimeSettings}
        />
      </>
    );
  }

  return (
    <ThemeProvider>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>

      <main className="min-h-screen bg-friction-bg text-friction-text">
        <AssistantRuntimeProvider runtime={assistantThreadRuntime}>
          <div className="friction-modern-layout">
            <aside
              className={[
                "friction-modern-sidebar",
                sidebarCollapsed ? "is-collapsed" : "",
              ].join(" ")}
              aria-label="Saved sessions"
            >
              <div className="friction-modern-sidebar-body">
                <div className="aui-root friction-threadlist-sidebar">
                  <ThreadList />
                </div>
              </div>
              <footer className="friction-modern-sidebar-footer">
                <Button
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings2 className="h-4 w-4" aria-hidden="true" />
                  Settings
                </Button>
                <Button
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={() => void handleSaveSessionLocal()}
                  disabled={!canPersistSession || saveLocalLoading}
                >
                  <Save className="h-4 w-4" aria-hidden="true" />
                  {saveLocalLoading ? "Saving…" : "Snapshot"}
                </Button>
                <Button
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={handleExportSession}
                  disabled={!canPersistSession}
                >
                  <Download className="h-4 w-4" aria-hidden="true" />
                  Export
                </Button>
              </footer>
            </aside>

            <section id="main-content" className="friction-modern-main">
              <header className="friction-modern-header">
                <div className="friction-modern-header-left">
                  <Button
                    variant="ghost"
                    className="friction-modern-sidebar-toggle"
                    onClick={() => setSidebarCollapsed((value) => !value)}
                  >
                    <PanelLeft className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <div>
                    <h1 className="friction-modern-title">Friction</h1>
                    <p className="friction-modern-subtitle">
                      Multi-AI disagreement engine for bugs, decisions, and open
                      problems.
                    </p>
                  </div>
                </div>
                <div className="friction-modern-header-right">
                  <ThemeToggle />
                </div>
              </header>
              {saveStatus ? (
                <p className="text-xs text-friction-muted">{saveStatus}</p>
              ) : null}
              {error ? (
                <p
                  className="rounded-lg border border-friction-border bg-friction-surface-alt px-3 py-2 text-xs text-friction-danger"
                  role="alert"
                >
                  {error}
                </p>
              ) : null}
              <div className="friction-modern-body">
                <div className="workflow-chat-layout">
                  <ConversationShell
                    taskRail={<TaskRail currentStep={workflowStep} />}
                    composer={
                      <WorkflowPromptInput
                        value={composerText}
                        onChange={setComposerText}
                        onSubmit={() => void handleComposerSubmit()}
                        disabled={isBusy || workflowStep === "phase3_run"}
                        placeholder={PROMPT_HINTS[workflowStep]}
                        accessory={composerAccessory}
                        workflowStep={workflowStep}
                        phase12Agents={phase12AgentsSafe}
                        phase3AgentACli={phase3AgentACli}
                        phase3AgentBCli={phase3AgentBCli}
                        onAddPhase12Agent={handleAddPhase12Agent}
                        onRemovePhase12Agent={handleRemovePhase12Agent}
                        onAgentCliChange={handleAgentCliChange}
                        activePromptModelAgentId={activePromptModelAgentId}
                        onActivePromptModelAgentChange={
                          setActivePromptModelAgentId
                        }
                        agentCliModels={agentCliModels}
                        cliModels={cliModels}
                        cliModelInventory={cliModelInventory}
                        cliModelInventoryLoading={cliModelInventoryLoading}
                        cliModelInventoryLoaded={cliModelInventoryLoaded}
                        onRequestCliModelInventory={refreshCliModelInventory}
                        opencodeModels={opencodeModels}
                        onAgentCliModelChange={handleAgentCliModelChange}
                        judgeProvider={judgeProvider}
                        judgeModel={judgeModel}
                        onJudgeProviderChange={setJudgeProvider}
                        onJudgeModelChange={setJudgeModel}
                      />
                    }
                    scrollAnchorRef={scrollAnchorRef}
                  >
                    <div
                      ref={threadSurfaceRef}
                      className="aui-root friction-thread-surface friction-thread-surface-modern"
                    >
                      <Thread
                        welcome={threadWelcome}
                        composer={{ allowAttachments: false }}
                        userMessage={{ allowEdit: false }}
                        assistantMessage={threadAssistantMessageConfig}
                        components={threadComponents}
                        strings={threadStrings}
                      />
                      {showThreadScrollToBottom ? (
                        <button
                          type="button"
                          className="thread-scroll-bottom-bubble"
                          onClick={() => scrollThreadToBottom("smooth")}
                          aria-label="Scroll to latest message"
                          title="Scroll to latest message"
                        >
                          <ArrowDown className="h-4 w-4" aria-hidden="true" />
                        </button>
                      ) : null}
                    </div>
                  </ConversationShell>
                </div>
              </div>
            </section>
          </div>
        </AssistantRuntimeProvider>
      </main>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={handleSettingsOpenChange}
        judgeProviderOptions={JUDGE_PROVIDER_OPTIONS}
        phase12Agents={phase12AgentsSafe}
        phase3AgentACli={phase3AgentACli}
        phase3AgentBCli={phase3AgentBCli}
        cliCommands={cliCommands}
        cliModels={cliModels}
        cliModelInventory={cliModelInventory}
        agentCliModels={agentCliModels}
        cliCommandStatuses={onboardingCliStatuses}
        opencodeModels={opencodeModels}
        opencodeModelsLoading={opencodeModelsLoading}
        opencodeModelsError={opencodeModelsError}
        cliDiagnosticsLoading={phase12DiagnosticsLoading}
        cliDiagnosticsError={phase12DiagnosticsError}
        judgeProvider={judgeProvider}
        judgeModel={judgeModel}
        ollamaHost={ollamaHost}
        autoCleanup={autoCleanup}
        onPhase12AgentsChange={setPhase12Agents}
        onPhase3AgentACliChange={setPhase3AgentACli}
        onPhase3AgentBCliChange={setPhase3AgentBCli}
        onCliCommandChange={handleCliCommandChange}
        onAgentCliModelChange={handleAgentCliModelChange}
        onCliModelChange={handleCliModelChange}
        onJudgeProviderChange={setJudgeProvider}
        onJudgeModelChange={setJudgeModel}
        onOllamaHostChange={setOllamaHost}
        onAutoCleanupChange={setAutoCleanup}
        onRefreshOpencodeModels={() => void handleRefreshOpencodeModels()}
        onRerunCliOnboarding={handleRerunCliOnboarding}
        onResetRuntimeSettings={handleResetRuntimeSettings}
      />

      <SessionsDrawer
        open={sessionsDrawerOpen}
        onOpenChange={setSessionsDrawerOpen}
        sessions={recentSessions}
        activeSessionId={routeState.sessionId}
        onLoadSession={handleLoadSession}
        onOpenSettings={() => handleSettingsOpenChange(true)}
        onNewSession={handleRestart}
        onSaveSession={() => void handleSaveSessionLocal()}
        onExportSession={handleExportSession}
        canPersistSession={canPersistSession}
        saveLocalLoading={saveLocalLoading}
      />

      <ConfirmDialog
        open={confirmOpen}
        title={confirmIntent?.title ?? "Confirm action"}
        description={
          confirmIntent?.description ??
          "This action may discard your current progress."
        }
        confirmLabel={confirmIntent?.confirmLabel ?? "Confirm"}
        onOpenChange={setConfirmOpen}
        onConfirm={() => confirmActionRef.current?.()}
      />
    </ThemeProvider>
  );
}
