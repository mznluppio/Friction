import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { Thread, ThreadList } from "@assistant-ui/react-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  Download,
  PanelLeft,
  Save,
  Settings2,
} from "lucide-react";
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
import { DecisionPhase2Inline } from "./components/chat/DecisionPhase2Inline";
import { FrictionPhase1Inline } from "./components/chat/FrictionPhase1Inline";
import { FrictionInboxCard } from "./components/chat/FrictionInboxCard";
import { Phase3ValidateInline } from "./components/chat/Phase3ValidateInline";
import { PlanCard } from "./components/chat/PlanCard";
import { AssistantMessageArtifactAware } from "./components/chat/AssistantMessageArtifactAware";
import { WorkflowDoneInline } from "./components/chat/WorkflowDoneInline";
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
  RouteState,
  RuntimeSettings,
  SessionSummary,
  UnsavedState,
  WorkflowStep,
} from "./lib/types";

type ConfirmIntent = {
  title: string;
  description: string;
  confirmLabel: string;
};

const APP_VERSION = "1.2.0";
const PROMPT_BUNDLE_VERSION = "friction-prompts.2026-03-03";

import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";

const MarkdownText = (props: any) => (
  <MarkdownTextPrimitive {...props} remarkPlugins={[remarkGfm]} />
);

const SETTINGS_KEY = "friction.settings.v1";
const CLI_SETUP_KEY_V2 = "friction.cliSetup.v2.complete";
const CLI_SETUP_KEY_LEGACY_V1 = "friction.cliSetup.v1.complete";
const DRAFT_KEY = "friction.draft";

const JUDGE_PROVIDER_OPTIONS: JudgeProvider[] = ["haiku", "flash", "ollama"];
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
  clarifications: [],
  decision: [],
  phase3_config: [],
  phase3_run: [],
  completed: [
    "Save session",
    "Export session",
    "Export consented dataset",
    "New session",
  ],
};

const PROMPT_HINTS: Record<WorkflowStep, string> = {
  requirement: "Describe the feature or system requirement in detail…",
  clarifications:
    "Resolve friction points in the inline card, then click Resolve & Run Phase 2…",
  decision: "Use the inline arbitration block to apply the Phase 2 decision…",
  phase3_config:
    "Use the inline Phase 3 block to run validation…",
  phase3_run: "Validation running…",
  completed: "Workflow completed — use the inline Done actions below.",
};

function withTrimmed(value: string): string {
  return value.trim();
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

const MIN_FRICTION_RATIONALE_LENGTH = 12;

function frictionResolutionKey(
  divergence: Divergence,
  index: number,
): string {
  return `${divergence.field}:${index}`;
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
    resolutions: draft.resolutions.map((item) => ({
      ...item,
      choice: normalizeFrictionChoice(item.choice),
    })),
  };
}

function createFrictionInboxDraft(result: Phase1Result): FrictionInboxDraft {
  return {
    status: result.divergences.length === 0 ? "ready" : "draft",
    resolutions: result.divergences.map((divergence, index) => ({
      key: frictionResolutionKey(divergence, index),
      field: divergence.field,
      severity: divergence.severity,
      rationale: "",
    })),
  };
}

function computeFrictionGateState(
  result: Phase1Result | null,
  draft: FrictionInboxDraft | null,
): { ready: boolean; invalidKeys: string[] } {
  if (!result || !draft) return { ready: false, invalidKeys: [] };

  const invalidKeys = result.divergences
    .map((divergence, index) => frictionResolutionKey(divergence, index))
    .filter((key) => {
      const entry = draft.resolutions.find((item) => item.key === key);
      if (!entry?.choice) return true;
      return (
        normalizeFrictionRationale(entry.rationale).length <
        MIN_FRICTION_RATIONALE_LENGTH
      );
    });

  return {
    ready: result.divergences.length === 0 || invalidKeys.length === 0,
    invalidKeys,
  };
}

function inferFrictionDirection(
  draft: FrictionInboxDraft,
): FrictionResolutionChoice {
  if (draft.direction) {
    const normalizedDirection = normalizeFrictionChoice(draft.direction);
    if (normalizedDirection) return normalizedDirection;
  }

  const votes = draft.resolutions
    .map((item) => normalizeFrictionChoice(item.choice))
    .filter((choice): choice is FrictionResolutionChoice => Boolean(choice));
  if (votes.length === 0) return "hybrid";

  const agentVoteCount = new Map<string, number>();
  votes.forEach((choice) => {
    const agentId = frictionChoiceAgentId(choice);
    if (!agentId) return;
    agentVoteCount.set(agentId, (agentVoteCount.get(agentId) ?? 0) + 1);
  });

  let topAgentId: string | null = null;
  let topCount = 0;
  agentVoteCount.forEach((count, agentId) => {
    if (count > topCount) {
      topAgentId = agentId;
      topCount = count;
    } else if (count === topCount) {
      topAgentId = null;
    }
  });

  if (!topAgentId) return "hybrid";
  if (topCount * 2 <= votes.length) return "hybrid";
  return `agent:${topAgentId}`;
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
  const lines: string[] = [];
  const inferredDirection = inferFrictionDirection(draft);
  lines.push(`Direction: ${frictionChoiceLabel(inferredDirection, phase1Agents)}`);
  lines.push("");
  lines.push("Resolved friction points:");

  if (result.divergences.length === 0) {
    lines.push("- No friction points detected.");
  } else {
    result.divergences.forEach((divergence, index) => {
      const key = frictionResolutionKey(divergence, index);
      const entry = draft.resolutions.find((item) => item.key === key);
      const normalizedChoice = normalizeFrictionChoice(entry?.choice) ?? "hybrid";
      const choice =
        normalizedChoice === "hybrid"
          ? "Hybrid"
          : `Prefer ${frictionChoiceLabel(normalizedChoice, phase1Agents)}`;
      const rationale = normalizeFrictionRationale(entry?.rationale ?? "");
      lines.push(`${index + 1}. [${divergence.field}] Choice: ${choice}`);
      lines.push(`Rationale: ${rationale || "No rationale provided."}`);
    });
  }

  lines.push("");
  lines.push("Hard constraints:");
  lines.push("None specified.");
  return lines.join("\n");
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
  const lines: string[] = [];

  lines.push(
    frictionCount === 0
      ? "Phase 1 complete — agents aligned on the requirement."
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
  lines.push("Next step: resolve friction points in the inline card below.");
  lines.push("Once all points are resolved, click Resolve & Run Phase 2.");

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

/** Build the assistant message shown after Phase 2 completes. */
function buildPhase2CompletionMessage(
  result: Phase2Result,
  phase2Agents: PhaseAgentPlan[],
): string {
  const frictionCount = result.divergences.length;
  const lines: string[] = [];
  const agentCount = phase2Agents.length;

  lines.push(
    frictionCount === 0
      ? `Phase 2 complete — ${agentCount} agent${agentCount > 1 ? "s" : ""} converged on a plan.`
      : `Phase 2 complete — ${frictionCount} plan divergence${frictionCount > 1 ? "s" : ""} to arbitrate.`,
  );

  // Core tension from architecture or stack divergence
  const coreDiv =
    result.divergences.find((d) => d.field === "architecture") ??
    result.divergences.find((d) => d.field === "stack") ??
    result.divergences[0];

  if (coreDiv) {
    lines.push("");
    lines.push(`Core debate (${coreDiv.field}):`);
    if (coreDiv.a)
      lines.push(
        `• ${phase2Agents[0]?.label ?? "Agent A"} → ${firstSentence(coreDiv.a)}`,
      );
    if (coreDiv.b)
      lines.push(
        `• ${phase2Agents[1]?.label ?? "Agent B"} → ${firstSentence(coreDiv.b)}`,
      );
    if (coreDiv.consensusText)
      lines.push(`• Consensus → ${firstSentence(coreDiv.consensusText)}`);
    if (coreDiv.consensusItems?.length) {
      lines.push(
        `• Consensus items → ${coreDiv.consensusItems.slice(0, 5).join(", ")}`,
      );
    }
    if (coreDiv.outlierAgentIds?.length) {
      const labelMap = new Map(
        phase2Agents.map((agent) => [agent.id, agent.label]),
      );
      lines.push(
        `• Outliers → ${coreDiv.outlierAgentIds.map((id) => labelMap.get(id) ?? id).join(", ")}`,
      );
    }
  }

  // Decision guide
  lines.push("");
  lines.push("Write your arbitration decision:");
  lines.push(
    `① Choose a baseline plan — ${phase2Agents.map((item) => item.label).join(" / ")} or hybrid.`,
  );
  lines.push(
    "② Accept tradeoffs — name at least one tradeoff you are consciously accepting.",
  );

  const highSeverity = result.divergences.filter((d) => d.severity === "high");
  if (highSeverity.length > 0) {
    lines.push(
      `③ High-severity divergence${highSeverity.length > 1 ? "s" : ""} to address: ${highSeverity.map((d) => d.field).join(", ")}.`,
    );
  }

  return lines.join("\n");
}

function phaseFromStep(step: WorkflowStep): AppPhase {
  if (step === "requirement" || step === "clarifications") return 1;
  if (step === "decision") return 2;
  return 3;
}

function stepFromPhase(phase: AppPhase): WorkflowStep {
  if (phase === 1) return "requirement";
  if (phase === 2) return "decision";
  return "phase3_config";
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
      text: "Describe your requirement. I will run phase 1 automatically after you send.",
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

function isCliCommandLogEventPayload(value: unknown): value is CliCommandLogEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<CliCommandLogEvent>;
  if (typeof event.requestId !== "string" || !event.requestId.trim()) return false;
  if (event.phase !== 1 && event.phase !== 2 && event.phase !== 3) return false;
  if (typeof event.kind !== "string" || !event.kind.trim()) return false;
  if (typeof event.timestamp !== "string" || !event.timestamp.trim()) return false;
  return true;
}

function createCliTimelineRun(
  requestId: string,
  phase: 1 | 2 | 3,
  timestamp?: string,
): CliTimelineRun {
  const now = timestamp && timestamp.trim() ? timestamp : new Date().toISOString();
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
    const content = typeof record.content === "string" ? record.content.trim() : "";
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
    const status = typeof record.status === "string" ? record.status : "unknown";
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
    ? { ...next[runIndex], commands: next[runIndex].commands.map((command) => ({ ...command })) }
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
      agentLabel: withTrimmed(event.agentLabel ?? "") || `Command ${fallbackIndex}`,
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

// ── Draft auto-save ───────────────────────────────────────────────────────────
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
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as WorkflowDraft;
  } catch {
    return null;
  }
}

function writeDraft(draft: WorkflowDraft): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // localStorage unavailable or full – silently ignore
  }
}

function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // ignore
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
  const handleLoadSessionRef = useRef<(id: string) => void>(() => {});
  const handleRestartRef = useRef<() => void>(() => {});
  const submitWorkflowInputRef = useRef<
    (input: string) => Promise<void> | void
  >(() => {});

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
  const hasUnsaved =
    unsavedState.phase1Dirty ||
    unsavedState.phase2Dirty ||
    unsavedState.phase3Dirty;
  const canPersistSession = Boolean(phase1Result && phase2Result);
  const phase12AgentsSafe = useMemo(
    () => ensureAtLeastTwoPhaseAgents(phase12Agents),
    [phase12Agents],
  );
  const promptModelAgentIds = useMemo(() => {
    if (
      workflowStep === "phase3_config" ||
      workflowStep === "phase3_run" ||
      workflowStep === "completed"
    ) {
      return ["phase3_agent_a", "phase3_agent_b"];
    }
    return phase12AgentsSafe.slice(0, MAX_PHASE_AGENTS).map((agent) => agent.id);
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
      AGENT_CLI_OPTIONS.map((alias) => `${alias}:${cliCommands[alias] ?? ""}`).join("|"),
    [cliCommands]
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
          .map(
            (command) => {
              return `${command.commandId}:${command.status}:${command.exitCode ?? ""}:${command.updatedAt}:${command.rawOutput.length}:${command.readableOutput.length}`;
            },
          )
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
          (resolution) =>
            Boolean(resolution.choice) &&
            normalizeFrictionRationale(resolution.rationale).length >=
              MIN_FRICTION_RATIONALE_LENGTH,
        ).length;
        tokens.set(
          item.id,
          `${frictionInboxDraft.status}:${frictionInboxDraft.direction ?? ""}:${phase2Loading ? "1" : "0"}:${resolvedCount}`,
        );
        return;
      }

      if (item.type === "decision_phase2") {
        const structured = phase2Result?.humanDecisionStructured
          ? JSON.stringify(phase2Result.humanDecisionStructured)
          : "";
        tokens.set(
          item.id,
          `${workflowStep}:${phase2Loading ? "1" : "0"}:${withTrimmed(decision)}:${structured}`,
        );
        return;
      }

      if (item.type === "validate_phase3") {
        tokens.set(
          item.id,
          `${workflowStep}:${phase3Loading ? "1" : "0"}:${withTrimmed(repoPath)}:${withTrimmed(baseBranch)}:${consentedToDataset ? "1" : "0"}:${withTrimmed(phase3FormError ?? "")}`,
        );
        return;
      }

      if (item.type === "workflow_done") {
        tokens.set(
          item.id,
          `${workflowStep}:${saveLocalLoading ? "1" : "0"}:${datasetLoading ? "1" : "0"}:${withTrimmed(saveStatus ?? "")}`,
        );
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
    const nextMessages: { id: string; role: "assistant" | "user"; content: string }[] = [];

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
      title: withTrimmed(session.requirementPreview) || session.id.slice(0, 8),
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
        const cardAgents = phase1AgentsFromResult(sourcePhase1, phase12AgentsSafe);
        return (
          <FrictionPhase1Inline
            phase1={sourcePhase1}
            agents={cardAgents}
            draft={frictionInboxDraft}
            submitting={phase2Loading}
            onDirectionChange={updateFrictionDirection}
            onResolutionChange={updateFrictionResolution}
            onSubmit={(draftOverride) => {
              void submitFrictionInbox(draftOverride);
            }}
          />
        );
      }

      if (item.type === "friction_inbox") {
        const sourcePlan = conversationArtifactById.get(
          item.payload.sourcePlanItemId,
        );
        const sourcePhase1 =
          sourcePlan?.type === "plan" &&
          sourcePlan.payload.phase === 1 &&
          sourcePlan.payload.phase1
            ? sourcePlan.payload.phase1
            : phase1Result;
        if (!sourcePhase1 || !frictionInboxDraft) {
          return (
            <p className="text-xs text-friction-muted">
              Preparing friction points…
            </p>
          );
        }
        const cardAgents = phase1AgentsFromResult(sourcePhase1, phase12AgentsSafe);
        return (
          <FrictionInboxCard
            phase1={sourcePhase1}
            agents={cardAgents}
            draft={frictionInboxDraft}
            submitting={phase2Loading}
            onDirectionChange={updateFrictionDirection}
            onResolutionChange={updateFrictionResolution}
            onSubmit={(draftOverride) => {
              void submitFrictionInbox(draftOverride);
            }}
          />
        );
      }

      if (item.type === "decision_phase2") {
        const p2Agents = phase2AgentsFromResult(item.payload.phase2, phase12AgentsSafe);
        if (p2Agents.length < 2) {
          return (
            <p className="text-xs text-friction-muted">
              Preparing arbitration…
            </p>
          );
        }
        return (
          <DecisionPhase2Inline
            plans={p2Agents}
            disabled={isBusy}
            onApplyDecision={(note, structured) => {
              handleDecisionStep(note, structured);
            }}
          />
        );
      }

      if (item.type === "validate_phase3") {
        return (
          <Phase3ValidateInline
            repoPath={repoPath}
            baseBranch={baseBranch}
            consentedToDataset={consentedToDataset}
            running={phase3Loading}
            error={phase3FormError}
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
            onRun={() => {
              void handlePhase3Step();
            }}
          />
        );
      }

      if (item.type === "workflow_done") {
        return (
          <WorkflowDoneInline
            canPersistSession={canPersistSession}
            saveLocalLoading={saveLocalLoading}
            datasetLoading={datasetLoading}
            onSave={() => {
              void handleSaveSessionLocal();
            }}
            onExportSession={handleExportSession}
            onExportDataset={() => {
              void handleExportDataset();
            }}
            onNewThread={handleRestart}
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
              title="Phase 2 — Multi-agent plans"
              summary={`${p2.divergences.length} plan divergence${p2.divergences.length !== 1 ? "s" : ""} · ${p2Agents.length} plan variants`}
              defaultOpen={false}
            >
              <DivergenceBlock
                title="Plan divergences"
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
            title="Phase 3 output"
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
      conversationArtifactById,
      frictionInboxDraft,
      handleSuggestionPick,
      phase1Result,
      phase12AgentsSafe,
      phase2Loading,
      phase3FormError,
      phase3Loading,
      repoPath,
      baseBranch,
      consentedToDataset,
      canPersistSession,
      saveLocalLoading,
      datasetLoading,
      handleExportDataset,
      handleExportSession,
      handleRestart,
      handleSaveSessionLocal,
      handleDecisionStep,
      submitFrictionInbox,
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

  const AssistantThreadText = useCallback(
    (props: any) => {
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
            <p className="text-xs text-friction-muted">Preparing artifact output…</p>
          </div>
        );
      }
      return (
        <div className="thread-assistant-text">
          <MarkdownText {...props} />
        </div>
      );
    },
    [],
  );
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
        "Describe your requirement. I will run phase 1 automatically after you send.",
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
          error: status === "failed" ? withTrimmed(error ?? "") || run.error : undefined,
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
            typeof patch.rationale === "string" ? patch.rationale : item.rationale,
        };
      });
      const nextDraft: FrictionInboxDraft = {
        ...previous,
        resolutions: nextResolutions,
      };
      if (phase1Result) {
        nextDraft.status = computeFrictionGateState(phase1Result, nextDraft).ready
          ? "ready"
          : "draft";
      } else {
        nextDraft.status = "draft";
      }
      if (phase1Result && !phase2Result) {
        writeDraft({
          requirement,
          clarifications,
          decision,
          phase1Result,
          phase2Result: null,
          frictionInboxDraft: nextDraft,
          workflowStep: "clarifications",
          savedAt: new Date().toISOString(),
        });
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
      if (phase1Result && !phase2Result) {
        writeDraft({
          requirement,
          clarifications,
          decision,
          phase1Result,
          phase2Result: null,
          frictionInboxDraft: nextDraft,
          workflowStep: "clarifications",
          savedAt: new Date().toISOString(),
        });
      }
      return nextDraft;
    });
  }

  async function submitFrictionInbox(draftOverride?: FrictionInboxDraft) {
    const effectiveDraft = draftOverride ?? frictionInboxDraft;
    if (!phase1Result || !requirement || !effectiveDraft) {
      appendError("Run requirement analysis first.", "clarifications");
      transitionWorkflow("requirement");
      return;
    }

    const gate = computeFrictionGateState(phase1Result, effectiveDraft);
    if (!gate.ready) {
      appendError(
        "Resolve every friction point with a choice and rationale before running Phase 2.",
        "clarifications",
      );
      return;
    }

    if (draftOverride) {
      setFrictionInboxDraft(draftOverride);
    }
    const phase1Agents = phase1AgentsFromResult(phase1Result, phase12AgentsSafe);
    const clarificationsText = buildClarificationsFromFrictionInbox(
      phase1Result,
      effectiveDraft,
      phase1Agents,
    );
    await handleClarificationsStep(clarificationsText);
  }

  function validateRequirement(value: string): string | null {
    if (withTrimmed(value).length < 8)
      return "Requirement must be at least 8 characters.";
    return null;
  }

  function validateClarifications(value: string): string | null {
    if (withTrimmed(value).length < 10)
      return "Clarifications must be at least 10 characters.";
    return null;
  }

  function validateDecision(value: string): string | null {
    if (withTrimmed(value).length < 12)
      return "Decision note must be at least 12 characters.";
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
      const safe = ensureAtLeastTwoPhaseAgents(previous).slice(0, MAX_PHASE_AGENTS);
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

    const keptAgents = phase12AgentsSafe.filter((agent) => agent.id !== agentId);
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
        )
      );
      const inventories: CliAliasModelInventory[] = [];
      let opencodeFailure: string | null = null;

      settled.forEach((result, index) => {
        const alias = targets[index];
        const durationMs = Math.max(
          1,
          Math.round(performance.now() - (startedAtByAlias.get(alias) ?? performance.now())),
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
        const canReusePreviousModels = Boolean(previousInventory?.models?.length);
        inventories.push({
          alias,
          models: canReusePreviousModels ? previousInventory?.models ?? [] : [],
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
            (inventory) => inventory.alias === "opencode"
          );
          if (opencodeInventory) {
            const deduped = Array.from(
              new Set(opencodeInventory.models.map((model) => model.trim()).filter(Boolean))
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
        "Send a longer requirement",
        "requirement",
        undefined,
        SUGGESTION_SETS.requirement,
      );
      return;
    }

    // Starting a fresh workflow – discard any previous draft
    clearDraft();

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

      // Auto-save draft after phase 1
      writeDraft({
        requirement: input,
        clarifications: "",
        decision: "",
        phase1Result: result,
        phase2Result: null,
        frictionInboxDraft: nextFrictionDraft,
        workflowStep: "clarifications",
        savedAt: new Date().toISOString(),
      });

      transitionWorkflow("clarifications");

      appendText(
        "assistant",
        buildPhase1CompletionMessage(result, resultAgents),
        "clarifications",
      );
      appendConversation({
        id: crypto.randomUUID(),
        type: "friction_phase1",
        payload: {
          phase: 1,
          phase1: result,
          meta: metaFor("clarifications"),
        },
      });
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

  async function handleClarificationsStep(input: string) {
    if (!phase1Result || !requirement) {
      appendError("Run requirement analysis first.", "clarifications");
      transitionWorkflow("requirement");
      return;
    }

    const issue = validateClarifications(input);
    if (issue) {
      appendError(issue, "clarifications");
      return;
    }

    setError(null);
    setSaveStatus(null);
    setClarifications(input);
    setUnsavedState((prev) => ({ ...prev, phase2Dirty: true }));

    let runtimeDiagnostic: Phase12RuntimeDiagnostic | null = null;
    try {
      runtimeDiagnostic = await diagnosePhase12BeforeRun();
    } catch (caught) {
      const message = extractErrorMessage(caught);
      setError(message);
      appendError(message, "clarifications");
      return;
    }

    const selectionMismatches = selectionMismatchEntries(runtimeDiagnostic);
    if (selectionMismatches.length > 0) {
      const message = formatPhase12SelectionMismatchError(selectionMismatches);
      setError(message);
      appendError(message, "clarifications");
      setSettingsOpen(true);
      return;
    }

    if (runtimeDiagnostic.agents.some(cliMismatch)) {
      const message = formatPhase12MismatchError(runtimeDiagnostic);
      setError(message);
      appendError(message, "clarifications");
      setSettingsOpen(true);
      return;
    }

    const readinessFailures = phase12ReadinessFailures(runtimeDiagnostic);
    if (readinessFailures.length > 0) {
      const message = formatPhase12ReadinessError(readinessFailures);
      setError(message);
      appendError(message, "clarifications");
      setSettingsOpen(true);
      return;
    }

    appendStatus(
      "Runtime",
      "clarifications",
      buildRuntimeSummary("phase12", false),
      false,
    );
    appendStatus(
      "Running phase 2",
      "clarifications",
      "Generating multi-agent plans…",
      true,
    );
    const phase2StreamRequestId = startCliTimelineRun(2, "clarifications");
    setPhase2Loading(true);

    try {
      const result = await runPhase2(requirement, input, runtimeSettings, {
        streamRequestId: phase2StreamRequestId,
      });
      const resultPlans = phase2AgentsFromResult(result, phase12AgentsSafe);
      setPhase2Result(result);
      setFrictionInboxDraft((previous) =>
        previous
          ? {
              ...previous,
              status: "submitted",
            }
          : previous,
      );
      setUnsavedState((prev) => ({ ...prev, phase2Dirty: false }));
      finalizeCliTimelineRun(phase2StreamRequestId, "finished");

      // Auto-save draft after phase 2
      writeDraft({
        requirement,
        clarifications: input,
        decision: "",
        phase1Result,
        phase2Result: result,
        frictionInboxDraft: frictionInboxDraft
          ? {
              ...frictionInboxDraft,
              status: "submitted",
            }
          : null,
        workflowStep: "decision",
        savedAt: new Date().toISOString(),
      });

      transitionWorkflow("decision");

      appendText(
        "assistant",
        buildPhase2CompletionMessage(result, resultPlans),
        "decision",
      );
      appendConversation({
        id: crypto.randomUUID(),
        type: "plan",
        payload: {
          phase: 2,
          phase2: result,
          meta: metaFor("decision"),
        },
      });
      appendConversation({
        id: crypto.randomUUID(),
        type: "decision_phase2",
        payload: {
          phase: 2,
          phase2: result,
          meta: metaFor("decision"),
        },
      });
    } catch (caught) {
      const message = extractErrorMessage(caught);
      finalizeCliTimelineRun(phase2StreamRequestId, "failed", message);
      setError(`Phase 2 failed: ${message}`);
      appendError(`Phase 2 failed: ${message}`, "clarifications");
      if (!runtimeDiagnostic) {
        void diagnosePhase12BeforeRun().catch(() => {
          // ignore diagnostics fallback errors in phase failure path
        });
      }
    } finally {
      setPhase2Loading(false);
    }
  }

  function handleDecisionStep(
    input: string,
    structured?: HumanDecisionStructured,
  ) {
    if (!phase2Result) {
      appendError("Run planning first.", "decision");
      transitionWorkflow("clarifications");
      return;
    }

    const issue = validateDecision(input);
    if (issue) {
      appendError(issue, "decision");
      return;
    }

    setDecision(input);
    const updatedPhase2Result: Phase2Result = {
      ...phase2Result,
      humanDecision: input,
      humanDecisionStructured:
        structured ?? phase2Result.humanDecisionStructured,
    };
    setPhase2Result(updatedPhase2Result);
    setUnsavedState((prev) => ({ ...prev, phase2Dirty: true }));

    // Auto-save draft with decision recorded
    writeDraft({
      requirement,
      clarifications,
      decision: input,
      phase1Result,
      phase2Result: updatedPhase2Result,
      frictionInboxDraft,
      workflowStep: "phase3_config",
      savedAt: new Date().toISOString(),
    });

    transitionWorkflow("phase3_config");

    appendText(
      "assistant",
      "Decision stored. Complete the inline validation block below, then run Phase 3.",
      "phase3_config",
    );
    appendConversation({
      id: crypto.randomUUID(),
      type: "validate_phase3",
      payload: {
        phase: 3,
        meta: metaFor("phase3_config"),
      },
    });
  }

  async function handlePhase3Step() {
    if (!phase2Result || !requirement || !clarifications || !decision) {
      appendError(
        "Complete steps 1 and 2 before running phase 3.",
        "phase3_config",
      );
      return;
    }

    const trimmedRepoPath = withTrimmed(repoPath);
    if (trimmedRepoPath.length < 3) {
      const message = "Repository path is required.";
      setPhase3FormError(message);
      appendError(message, "phase3_config");
      focusComposerInput();
      return;
    }

    setPhase3FormError(null);
    setError(null);
    setSaveStatus(null);
    setRepoPath(trimmedRepoPath);
    setUnsavedState((prev) => ({ ...prev, phase3Dirty: true }));

    transitionWorkflow("phase3_run");
    appendStatus(
      "Runtime",
      "phase3_run",
      buildRuntimeSummary("phase3", true),
      false,
    );
    appendStatus(
      "Running phase 3",
      "phase3_run",
      "Executing adversarial validation…",
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
      transitionWorkflow("completed");

      appendText(
        "assistant",
        "Phase 3 completed. Review findings and choose next action.",
        "completed",
      );
      appendConversation({
        id: crypto.randomUUID(),
        type: "code",
        payload: {
          phase: 3,
          phase3: result,
          repoPath: trimmedRepoPath,
          baseBranch: withTrimmed(baseBranch) || "main",
          meta: metaFor("completed"),
        },
      });
      appendConversation({
        id: crypto.randomUUID(),
        type: "workflow_done",
        payload: {
          phase: 3,
          meta: metaFor("completed"),
        },
      });
    } catch (caught) {
      const message = extractErrorMessage(caught);
      finalizeCliTimelineRun(phase3StreamRequestId, "failed", message);
      const fullMessage = `Phase 3 failed: ${message}`;
      setPhase3FormError(fullMessage);
      setError(fullMessage);
      appendError(fullMessage, "phase3_config");
      transitionWorkflow("phase3_config");
    } finally {
      setPhase3Loading(false);
    }
  }

  async function submitWorkflowInput(input: string) {
    if (isBusy) return;

    const normalizedInput = withTrimmed(input);
    if (!normalizedInput) return;

    const step = workflowStep;
    if (step === "clarifications") {
      appendText(
        "assistant",
        "Step 2 is friction-only. Resolve the inline Friction Inbox card, then click Resolve & Run Phase 2.",
        "clarifications",
      );
      return;
    }

    if (step === "decision") {
      appendText(
        "assistant",
        "Step 3 is inline-only. Use the arbitration block in the thread and click Apply decision.",
        "decision",
      );
      return;
    }

    if (step === "phase3_config") {
      appendText(
        "assistant",
        "Validation setup is inline-only. Use the Phase 3 block in the thread, then click Run Phase 3.",
        "phase3_config",
      );
      return;
    }

    if (step === "completed") {
      appendText(
        "assistant",
        "Workflow is complete. Use the inline Done block to save/export or start a new thread.",
        "completed",
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

  function buildSnapshot() {
    if (!phase1Result || !phase2Result) return null;

    return buildSessionExport(
      requirement,
      { ...phase1Result, humanClarifications: withTrimmed(clarifications) },
      { ...phase2Result, humanDecision: withTrimmed(decision) },
      phase3Result ?? placeholderPhase3(),
      consentedToDataset,
      runtimeSettings,
      APP_VERSION,
    );
  }

  function handleExportSession() {
    const snapshot = buildSnapshot();
    if (!snapshot) {
      const message = "Run phases 1 and 2 before exporting.";
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
    const snapshot = buildSnapshot();
    if (!snapshot) {
      const message = "Run phases 1 and 2 before saving.";
      setSaveStatus(message);
      appendError(message, workflowStep);
      return;
    }

    setSaveLocalLoading(true);
    setSaveStatus(null);

    try {
      const id = await saveSessionRecord(snapshot);
      await refreshRecentSessions();
      const message = `Session saved locally (${id.slice(0, 8)}…).`;
      setSaveStatus(message);
      appendStatus("Save complete", workflowStep, message, false);
      setUnsavedState({
        phase1Dirty: false,
        phase2Dirty: false,
        phase3Dirty: false,
      });
      // Draft is superseded by the persisted session record
      clearDraft();
    } catch (caught) {
      const message = extractErrorMessage(caught);
      const fullMessage = `Save failed: ${message}`;
      setSaveStatus(fullMessage);
      appendError(fullMessage, workflowStep);
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
    loadedPhase1: Phase1Result,
    loadedPhase2: Phase2Result,
    loadedPhase3: Phase3Result,
    nextStep: WorkflowStep,
  ): ConversationItem[] {
    const items: ConversationItem[] = [
      {
        id: crypto.randomUUID(),
        type: "assistant",
        text: `Session ${session.id.slice(0, 8)} loaded.`,
        meta: metaFor(nextStep),
      },
      {
        id: crypto.randomUUID(),
        type: "user",
        text: session.requirement,
        meta: metaFor("requirement"),
      },
      {
        id: crypto.randomUUID(),
        type: "plan",
        payload: {
          phase: 1,
          phase1: loadedPhase1,
          meta: metaFor("clarifications"),
        },
      },
      {
        id: crypto.randomUUID(),
        type: "user",
        text: session.phase1.human_clarifications,
        meta: metaFor("clarifications"),
      },
      {
        id: crypto.randomUUID(),
        type: "plan",
        payload: {
          phase: 2,
          phase2: loadedPhase2,
          meta: metaFor("decision"),
        },
      },
      {
        id: crypto.randomUUID(),
        type: "decision_phase2",
        payload: {
          phase: 2,
          phase2: loadedPhase2,
          meta: metaFor("decision"),
        },
      },
      {
        id: crypto.randomUUID(),
        type: "user",
        text: session.phase2.human_decision,
        meta: metaFor("decision"),
      },
      {
        id: crypto.randomUUID(),
        type: "validate_phase3",
        payload: {
          phase: 3,
          meta: metaFor("phase3_config"),
        },
      },
    ];

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
          meta: metaFor("completed"),
        },
      });
      items.push({
        id: crypto.randomUUID(),
        type: "workflow_done",
        payload: {
          meta: metaFor("completed"),
          phase: 3,
        },
      });
    }

    return items;
  }

  function buildConversationFromDraft(
    draft: WorkflowDraft,
  ): ConversationItem[] {
    const items: ConversationItem[] = [
      {
        id: crypto.randomUUID(),
        type: "assistant",
        text: `Draft restored (auto-saved ${formatDateTime(draft.savedAt)}).`,
        meta: metaFor(draft.workflowStep),
      },
      {
        id: crypto.randomUUID(),
        type: "user",
        text: draft.requirement,
        meta: metaFor("requirement"),
      },
    ];

    if (draft.phase1Result) {
      if (draft.phase2Result) {
        items.push({
          id: crypto.randomUUID(),
          type: "plan",
          payload: {
            phase: 1,
            phase1: draft.phase1Result,
            meta: metaFor("clarifications"),
          },
        });
      } else {
        items.push({
          id: crypto.randomUUID(),
          type: "friction_phase1",
          payload: {
            phase: 1,
            phase1: draft.phase1Result,
            meta: metaFor("clarifications"),
          },
        });
      }
    }

    if (draft.clarifications) {
      items.push({
        id: crypto.randomUUID(),
        type: "user",
        text: draft.clarifications,
        meta: metaFor("clarifications"),
      });
    }

    if (draft.phase2Result) {
      items.push({
        id: crypto.randomUUID(),
        type: "plan",
        payload: {
          phase: 2,
          phase2: draft.phase2Result,
          meta: metaFor("decision"),
        },
      });
      if (!draft.decision) {
        items.push({
          id: crypto.randomUUID(),
          type: "decision_phase2",
          payload: {
            phase: 2,
            phase2: draft.phase2Result,
            meta: metaFor("decision"),
          },
        });
      }
    }

    if (draft.decision) {
      items.push({
        id: crypto.randomUUID(),
        type: "user",
        text: draft.decision,
        meta: metaFor("decision"),
      });
      if (
        draft.workflowStep === "phase3_config" ||
        draft.workflowStep === "phase3_run" ||
        draft.workflowStep === "completed"
      ) {
        items.push({
          id: crypto.randomUUID(),
          type: "validate_phase3",
          payload: {
            phase: 3,
            meta: metaFor("phase3_config"),
          },
        });
      }
      if (draft.workflowStep === "completed") {
        items.push({
          id: crypto.randomUUID(),
          type: "workflow_done",
          payload: {
            phase: 3,
            meta: metaFor("completed"),
          },
        });
      }
    }

    items.push({
      id: crypto.randomUUID(),
      type: "task",
      payload: {
        title: "Draft restored — continue where you left off",
        description: `Step: ${draft.workflowStep}`,
        suggestions: SUGGESTION_SETS[draft.workflowStep],
        done: false,
        meta: metaFor(draft.workflowStep),
      },
    });

    return items;
  }

  function hydrateFromSession(session: FrictionSession) {
    const [phase1Architect, phase1Pragmatist] = session.phase1.interpretations;
    const [phase2Architect, phase2Pragmatist] = session.phase2.plans;
    const runtimePhase12Agents = phase12AgentsFromRuntime(
      session.metadata.runtime,
    );
    const runtimePhase3 = phase3CliFromRuntime(
      session.metadata.runtime,
      runtimePhase12Agents,
    );

    if (
      !phase1Architect ||
      !phase1Pragmatist ||
      !phase2Architect ||
      !phase2Pragmatist
    ) {
      const message = "Session is invalid: missing phase interpretation/plan.";
      setError(message);
      appendError(message, workflowStep);
      return;
    }

    const loadedPhase1: Phase1Result = {
      architect: phase1Architect,
      pragmatist: phase1Pragmatist,
      agentResponses: session.phase1.interpretations.map((response, index) => {
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
      divergences: session.phase1.divergences,
      humanClarifications: session.phase1.human_clarifications,
    };

    const loadedPhase2: Phase2Result = {
      architect: phase2Architect,
      pragmatist: phase2Pragmatist,
      agentPlans: session.phase2.plans.map((plan, index) => {
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
      divergences: session.phase2.divergences,
      humanDecision: session.phase2.human_decision,
      humanDecisionStructured: session.phase2.human_decision_structured,
    };

    const loadedPhase3: Phase3Result = {
      codeA: session.phase3.code_a,
      codeB: session.phase3.code_b,
      attackReport: session.phase3.attack_report,
      confidenceScore: session.phase3.confidence_score,
      adrPath: session.phase3.adr_path,
      adrMarkdown: session.phase3.adr_markdown,
      workflowMode: session.metadata.workflow_mode,
    };

    setRequirement(session.requirement);
    setClarifications(session.phase1.human_clarifications);
    setDecision(session.phase2.human_decision);
    setFrictionInboxDraft(null);
    setPhase12Agents(runtimePhase12Agents);
    setPhase3AgentACli(runtimePhase3.agentA);
    setPhase3AgentBCli(runtimePhase3.agentB);
    setPhase1Result(loadedPhase1);
    setPhase2Result(loadedPhase2);
    setPhase3Result(loadedPhase3);
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
      loadedPhase3.codeA || loadedPhase3.codeB ? "completed" : "phase3_config";
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
    }
  }

  function handleLoadSession(id: string) {
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
    clearDraft();
    resetCliTimelineRuns();
    setComposerText("");
    setRequirement("");
    setClarifications("");
    setDecision("");
    setFrictionInboxDraft(null);
    setPhase1Result(null);
    setPhase2Result(null);
    setPhase3Result(null);
    setRepoPath("");
    setBaseBranch("main");
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
    if (suggestion === "Save session") {
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
        setRequirement(draft.requirement);
        if (draft.clarifications) setClarifications(draft.clarifications);
        if (draft.decision) setDecision(draft.decision);
        setFrictionInboxDraft(
          draft.frictionInboxDraft
            ? normalizeFrictionInboxDraft(draft.frictionInboxDraft)
            : draft.phase2Result
              ? null
              : createFrictionInboxDraft(draft.phase1Result),
        );
        setPhase1Result(draft.phase1Result);
        if (draft.phase2Result) setPhase2Result(draft.phase2Result);
        setWorkflowStep(draft.workflowStep);
        setConversation(buildConversationFromDraft(draft));
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
    if (lastInventoryRefreshSignatureRef.current === inventoryRefreshSignature) {
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
    if (!routeState.sessionId) return;
    void performLoadSession(routeState.sessionId);
  }, [routeState.sessionId]);

  useEffect(() => {
    if (!hasUnsaved) return;

    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [hasUnsaved]);

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
  }, [assistantThreadMessages.length, getThreadViewport, syncThreadScrollState]);

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
    if (promptModelAgentIds.includes(activePromptModelAgentId))
      return;
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
              <div className="friction-modern-sidebar-head">
                <span className="friction-sidebar-logo" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                  </svg>
                </span>
                <span className="friction-sidebar-wordmark">Friction</span>
              </div>
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
                  {saveLocalLoading ? "Saving…" : "Save"}
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
                    <h1 className="friction-modern-title">Decision chat</h1>
                    <p className="friction-modern-subtitle">
                      Orchestrated workflow chat with automatic phase execution.
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
