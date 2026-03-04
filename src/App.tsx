import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { Thread, ThreadList } from "@assistant-ui/react-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  PanelLeft,
  Save,
  Settings2,
} from "lucide-react";
import { AgentCard } from "./components/AgentCard";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { DiffViewer } from "./components/DiffViewer";
import { DivergenceBlock } from "./components/DivergenceBlock";
import { MultiPlanArbitrationCard } from "./components/MultiPlanArbitrationCard";
import { PlanPanel } from "./components/PlanPanel";
import { SessionsDrawer } from "./components/SessionsDrawer";
import { SettingsDialog } from "./components/SettingsDialog";
import { OnboardingCliSetupScreen } from "./components/OnboardingCliSetupScreen";
import { ThemeProvider, ThemeToggle } from "./components/ThemeProvider";
import { CodeCard } from "./components/chat/CodeCard";
import { ConversationShell } from "./components/chat/ConversationShell";
import {
  ClarificationHelper,
  type ClarificationDirectionOption,
} from "./components/chat/ClarificationHelper";
import { PlanCard } from "./components/chat/PlanCard";
import { WorkflowPromptInput } from "./components/chat/prompt-input/WorkflowPromptInput";
import { ShimmerBlock } from "./components/chat/ShimmerBlock";
import { SuggestionChips } from "./components/chat/SuggestionChips";
import { TaskRail } from "./components/chat/TaskRail";
import { Button } from "./components/ui/button";
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
  FrictionSession,
  HumanDecisionStructured,
  JudgeProvider,
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

const DEFAULT_CLARIFICATION_DIRECTION = "hybrid";

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
    "Use the helper: choose direction, set hard constraints, answer open questions…",
  decision: "Pick a baseline plan (or hybrid) and justify key tradeoffs…",
  phase3_config:
    "Send to start adversarial validation with the settings above…",
  phase3_run: "Validation running…",
  completed: "Workflow completed — save, export, or start a new session.",
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

function collectTopQuestions(
  result: Phase1Result | null,
  phaseAgents: PhaseAgentRuntime[],
  limit = 3,
): string[] {
  if (!result) return [];
  const responses = phase1AgentsFromResult(result, phaseAgents);
  return responses
    .flatMap((item) => item.response.questions)
    .map((item) => withTrimmed(item))
    .filter(
      (item, index, values) =>
        item.length > 0 && values.indexOf(item) === index,
    )
    .slice(0, limit);
}

function buildClarificationTemplate(
  directionLabel: string,
  constraints: string,
  answers: string,
  questions: string[],
): string {
  const trimmedConstraints = withTrimmed(constraints);
  const trimmedAnswers = withTrimmed(answers);
  const lines: string[] = [
    `Direction: ${directionLabel}`,
    "Why: ",
    "",
    "Hard constraints:",
    trimmedConstraints ||
    "- Timeline:\n- Team size:\n- Existing infra:\n- Budget ceiling:",
    "",
    "Answers to agent questions:",
  ];

  if (trimmedAnswers) {
    lines.push(trimmedAnswers);
    return lines.join("\n");
  }

  if (questions.length === 0) {
    lines.push("- No unresolved question.");
    return lines.join("\n");
  }

  questions.forEach((question, index) => {
    lines.push(`${index + 1}. ${question}`);
    lines.push("Answer: ");
  });

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
  topQuestions: string[],
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
  lines.push("Next step: use the Clarification helper under the input.");
  lines.push(
    "Fill 3 blocks: Direction, Hard constraints, Answers to open questions.",
  );

  if (topQuestions.length > 0) {
    lines.push(`Priority question: ${topQuestions[0]}`);
  }

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

function conversationItemToAssistantThreadMessage(
  item: ConversationItem,
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
  const [clarificationDirection, setClarificationDirection] = useState<string>(
    DEFAULT_CLARIFICATION_DIRECTION,
  );
  const [clarificationConstraints, setClarificationConstraints] = useState("");
  const [clarificationAnswers, setClarificationAnswers] = useState("");
  const [clarificationPanelCollapsed, setClarificationPanelCollapsed] =
    useState(false);

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

  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);
  const onboardingAutoSelectAppliedRef = useRef(false);

  function focusComposerInput() {
    window.setTimeout(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        ".chat-composer-wrap textarea[name='message']",
      );
      textarea?.focus();
    }, 0);
  }

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
  const phase1Agents = useMemo(
    () => phase1AgentsFromResult(phase1Result, phase12AgentsSafe),
    [phase1Result, phase12AgentsSafe],
  );
  const clarificationQuestions = useMemo(
    () => collectTopQuestions(phase1Result, phase12AgentsSafe),
    [phase1Result, phase12AgentsSafe],
  );
  const clarificationDirectionOptions = useMemo<
    ClarificationDirectionOption[]
  >(() => {
    const agentOptions = phase1Agents.map((agent) => ({
      value: agent.id,
      label: agent.label,
      description:
        PHASE_AGENT_PRESETS.find((item) => item.id === agent.id)
          ?.directionDescription ?? "Agent perspective.",
    }));

    return [
      ...agentOptions,
      {
        value: DEFAULT_CLARIFICATION_DIRECTION,
        label: "Hybrid",
        description: "Combine multiple approaches with explicit tradeoffs.",
      },
    ];
  }, [phase1Agents]);
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
  const cliCommandsSignature = useMemo(
    () =>
      AGENT_CLI_OPTIONS.map((alias) => `${alias}:${cliCommands[alias] ?? ""}`).join("|"),
    [cliCommands]
  );
  const assistantThreadMessages = useMemo(() => {
    return conversation.map(conversationItemToAssistantThreadMessage).filter(
      (
        item,
      ): item is {
        id: string;
        role: "assistant" | "user";
        content: string;
      } => item !== null,
    );
  }, [conversation]);
  const assistantThreadListItems = useMemo(() => {
    return recentSessions.map((session) => ({
      status: "regular" as const,
      id: session.id,
      title: withTrimmed(session.requirementPreview) || session.id.slice(0, 8),
    }));
  }, [recentSessions]);
  const artifactConversationItems = useMemo(() => {
    return conversation.filter(
      (item) =>
        item.type === "task" || item.type === "plan" || item.type === "code",
    );
  }, [conversation]);
  const assistantThreadRuntime = useExternalStoreRuntime({
    isRunning: isBusy,
    messages: assistantThreadMessages,
    adapters: {
      threadList: {
        threadId: routeState.sessionId ?? undefined,
        threads: assistantThreadListItems,
        onSwitchToThread: async (threadId: string) => {
          handleLoadSession(threadId);
        },
        onSwitchToNewThread: async () => {
          handleRestart();
        },
      },
    },
    onNew: async (message: { content: unknown }) => {
      const text = extractThreadTextContent(message.content);
      if (!text) return;
      await submitWorkflowInput(text);
    },
    convertMessage: (message: {
      id: string;
      role: "assistant" | "user";
      content: string;
    }) => ({
      id: message.id,
      role: message.role,
      content: message.content,
    }),
  });

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
    const targets = Array.from(new Set(aliases));
    if (targets.length === 0) return;

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
        if (result.status === "fulfilled") {
          inventories.push(result.value);
          return;
        }
        inventories.push({
          alias,
          models: [],
          source: "fallback",
          reason: extractErrorMessage(result.reason),
          stale: false,
          lastUpdatedAt: new Date().toISOString(),
        });
        if (alias === "opencode") {
          opencodeFailure = extractErrorMessage(result.reason);
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
      phase12AgentsSafe.slice(0, 2).forEach((agent) => {
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

  function formatPhase12RuntimeDiagnostics(
    diagnostic: Phase12RuntimeDiagnostic,
  ): string {
    if (diagnostic.agents.length === 0) {
      return "No phase 1/2 agents found in runtime diagnostics.";
    }

    return diagnostic.agents
      .map((agent) => {
        const runtimeReady = agent.runtimeReady ?? true;
        const path = agent.resolvedBinaryPath ?? "not found";
        const model = agent.resolvedModel?.trim()
          ? agent.resolvedModel.trim()
          : "default";
        const modelSource = agent.resolvedModelSource?.trim()
          ? agent.resolvedModelSource.trim()
          : "default";
        const readiness = agent.requiresAuth
          ? ` · ready=${runtimeReady ? "yes" : "no"} (${agent.readinessSource ?? "none"})`
          : "";
        const readinessReason =
          !runtimeReady && agent.readinessReason
            ? ` · reason=${agent.readinessReason}`
            : "";
        return `${agent.label}: selected=${agent.selectedCli} → command='${agent.resolvedCommand}' (${agent.resolvedCommandSource}) · family=${agent.resolvedFamily} · path=${path} · model=${model} (${modelSource})${readiness}${readinessReason}`;
      })
      .join("\n");
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

  function handleInsertClarificationTemplate() {
    const directionLabel =
      clarificationDirectionOptions.find(
        (option) => option.value === clarificationDirection,
      )?.label ?? "Hybrid";
    const template = buildClarificationTemplate(
      directionLabel,
      clarificationConstraints,
      clarificationAnswers,
      clarificationQuestions,
    );

    setComposerText((previous) => {
      const trimmed = withTrimmed(previous);
      if (!trimmed) return template;
      return `${trimmed}\n\n${template}`;
    });
    focusComposerInput();
  }

  function handleInsertDecisionTemplate(
    note: string,
    structured: HumanDecisionStructured,
  ) {
    setComposerText((previous) => {
      const trimmed = withTrimmed(previous);
      if (!trimmed) return note;
      return `${trimmed}\n\n${note}`;
    });
    setPhase2Result((previous) =>
      previous
        ? {
          ...previous,
          humanDecisionStructured: structured,
        }
        : previous,
    );
    setUnsavedState((prev) => ({ ...prev, phase2Dirty: true }));
    focusComposerInput();
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
    setClarificationDirection(DEFAULT_CLARIFICATION_DIRECTION);
    setClarificationConstraints("");
    setClarificationAnswers("");
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
      appendStatus(
        "Runtime diagnostics",
        "requirement",
        formatPhase12RuntimeDiagnostics(runtimeDiagnostic),
        false,
      );
      setSettingsOpen(true);
      return;
    }

    if (runtimeDiagnostic.agents.some(cliMismatch)) {
      const message = formatPhase12MismatchError(runtimeDiagnostic);
      setError(message);
      appendError(message, "requirement");
      appendStatus(
        "Runtime diagnostics",
        "requirement",
        formatPhase12RuntimeDiagnostics(runtimeDiagnostic),
        false,
      );
      setSettingsOpen(true);
      return;
    }

    const readinessFailures = phase12ReadinessFailures(runtimeDiagnostic);
    if (readinessFailures.length > 0) {
      const message = formatPhase12ReadinessError(readinessFailures);
      setError(message);
      appendError(message, "requirement");
      appendStatus(
        "Runtime diagnostics",
        "requirement",
        formatPhase12RuntimeDiagnostics(runtimeDiagnostic),
        false,
      );
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
    setPhase1Loading(true);

    try {
      const result = await runPhase1(input, runtimeSettings);
      const resultAgents = phase1AgentsFromResult(result, phase12AgentsSafe);
      const resultQuestions = collectTopQuestions(result, phase12AgentsSafe);
      setPhase1Result(result);
      setUnsavedState((prev) => ({ ...prev, phase1Dirty: false }));

      // Auto-save draft after phase 1
      writeDraft({
        requirement: input,
        clarifications: "",
        decision: "",
        phase1Result: result,
        phase2Result: null,
        workflowStep: "clarifications",
        savedAt: new Date().toISOString(),
      });

      transitionWorkflow("clarifications");

      appendText(
        "assistant",
        buildPhase1CompletionMessage(result, resultAgents, resultQuestions),
        "clarifications",
      );
      appendConversation({
        id: crypto.randomUUID(),
        type: "plan",
        payload: {
          phase: 1,
          phase1: result,
          meta: metaFor("clarifications"),
        },
      });
      appendTask(
        "Write your clarification",
        "clarifications",
        "Use the helper below, insert the template, complete it, then send.",
        SUGGESTION_SETS.clarifications,
      );
    } catch (caught) {
      const message = extractErrorMessage(caught);
      setError(`Phase 1 failed: ${message}`);
      appendError(`Phase 1 failed: ${message}`, "requirement");
      if (runtimeDiagnostic) {
        appendStatus(
          "Runtime diagnostics",
          "requirement",
          formatPhase12RuntimeDiagnostics(runtimeDiagnostic),
          false,
        );
      } else {
        try {
          const fallbackDiagnostics = await diagnosePhase12BeforeRun();
          appendStatus(
            "Runtime diagnostics",
            "requirement",
            formatPhase12RuntimeDiagnostics(fallbackDiagnostics),
            false,
          );
        } catch {
          // ignore diagnostics fallback errors in phase failure path
        }
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
      appendStatus(
        "Runtime diagnostics",
        "clarifications",
        formatPhase12RuntimeDiagnostics(runtimeDiagnostic),
        false,
      );
      setSettingsOpen(true);
      return;
    }

    if (runtimeDiagnostic.agents.some(cliMismatch)) {
      const message = formatPhase12MismatchError(runtimeDiagnostic);
      setError(message);
      appendError(message, "clarifications");
      appendStatus(
        "Runtime diagnostics",
        "clarifications",
        formatPhase12RuntimeDiagnostics(runtimeDiagnostic),
        false,
      );
      setSettingsOpen(true);
      return;
    }

    const readinessFailures = phase12ReadinessFailures(runtimeDiagnostic);
    if (readinessFailures.length > 0) {
      const message = formatPhase12ReadinessError(readinessFailures);
      setError(message);
      appendError(message, "clarifications");
      appendStatus(
        "Runtime diagnostics",
        "clarifications",
        formatPhase12RuntimeDiagnostics(runtimeDiagnostic),
        false,
      );
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
    setPhase2Loading(true);

    try {
      const result = await runPhase2(requirement, input, runtimeSettings);
      const resultPlans = phase2AgentsFromResult(result, phase12AgentsSafe);
      setPhase2Result(result);
      setUnsavedState((prev) => ({ ...prev, phase2Dirty: false }));

      // Auto-save draft after phase 2
      writeDraft({
        requirement,
        clarifications: input,
        decision: "",
        phase1Result,
        phase2Result: result,
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
      appendTask(
        "Arbitration decision",
        "decision",
        `Use the scorecard helper: rate each plan (4 criteria), choose winner/hybrid, insert template, then send.`,
        SUGGESTION_SETS.decision,
      );
    } catch (caught) {
      const message = extractErrorMessage(caught);
      setError(`Phase 2 failed: ${message}`);
      appendError(`Phase 2 failed: ${message}`, "clarifications");
      if (runtimeDiagnostic) {
        appendStatus(
          "Runtime diagnostics",
          "clarifications",
          formatPhase12RuntimeDiagnostics(runtimeDiagnostic),
          false,
        );
      } else {
        try {
          const fallbackDiagnostics = await diagnosePhase12BeforeRun();
          appendStatus(
            "Runtime diagnostics",
            "clarifications",
            formatPhase12RuntimeDiagnostics(fallbackDiagnostics),
            false,
          );
        } catch {
          // ignore diagnostics fallback errors in phase failure path
        }
      }
    } finally {
      setPhase2Loading(false);
    }
  }

  function handleDecisionStep(input: string) {
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
    setPhase2Result({ ...phase2Result, humanDecision: input });
    setUnsavedState((prev) => ({ ...prev, phase2Dirty: true }));

    // Auto-save draft with decision recorded
    writeDraft({
      requirement,
      clarifications,
      decision: input,
      phase1Result,
      phase2Result: { ...phase2Result, humanDecision: input },
      workflowStep: "phase3_config",
      savedAt: new Date().toISOString(),
    });

    transitionWorkflow("phase3_config");

    appendText(
      "assistant",
      "Decision stored. Set repository path and base branch below, then send to run adversarial validation.",
      "phase3_config",
    );
    appendTask(
      "Configure validation",
      "phase3_config",
      "Repository path is required before running phase 3.",
      SUGGESTION_SETS.phase3_config,
    );
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
    setPhase3Loading(true);

    try {
      const result = await runPhase3Adversarial({
        repoPath: trimmedRepoPath,
        baseBranch: withTrimmed(baseBranch) || "main",
        requirement,
        clarifications,
        decision,
        judgeProvider,
        judgeModel: withTrimmed(judgeModel),
        runtimeSettings,
        autoCleanup,
      });

      setPhase3Result(result);
      setUnsavedState((prev) => ({ ...prev, phase3Dirty: false }));
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
      appendTask(
        "Workflow finished",
        "completed",
        "Persist or export this run.",
        SUGGESTION_SETS.completed,
      );
    } catch (caught) {
      const message = extractErrorMessage(caught);
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
    appendText("user", normalizedInput, step);

    if (step === "requirement") {
      await handleRequirementStep(normalizedInput);
      return;
    }

    if (step === "clarifications") {
      await handleClarificationsStep(normalizedInput);
      return;
    }

    if (step === "decision") {
      handleDecisionStep(normalizedInput);
      return;
    }

    if (step === "phase3_config") {
      await handlePhase3Step();
      return;
    }

    appendText(
      "assistant",
      "Workflow is complete. Use the action chips to save/export or start a new session.",
      "completed",
    );
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
        type: "user",
        text: session.phase2.human_decision,
        meta: metaFor("decision"),
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
        type: "task",
        payload: {
          title: "Workflow finished",
          description: "Persist or export this run.",
          suggestions: SUGGESTION_SETS.completed,
          done: false,
          meta: metaFor("completed"),
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
      items.push({
        id: crypto.randomUUID(),
        type: "plan",
        payload: {
          phase: 1,
          phase1: draft.phase1Result,
          meta: metaFor("clarifications"),
        },
      });
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
    }

    if (draft.decision) {
      items.push({
        id: crypto.randomUUID(),
        type: "user",
        text: draft.decision,
        meta: metaFor("decision"),
      });
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
    setClarificationDirection(DEFAULT_CLARIFICATION_DIRECTION);
    setClarificationConstraints("");
    setClarificationAnswers("");
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
    setComposerText("");
    setRequirement("");
    setClarifications("");
    setDecision("");
    setClarificationDirection(DEFAULT_CLARIFICATION_DIRECTION);
    setClarificationConstraints("");
    setClarificationAnswers("");
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

  useEffect(() => {
    void refreshRecentSessions();

    // Restore draft if one exists and no explicit session is being loaded via URL
    if (!readRouteStateFromLocation().sessionId) {
      const draft = readDraft();
      if (draft && draft.requirement && draft.phase1Result) {
        setRequirement(draft.requirement);
        if (draft.clarifications) setClarifications(draft.clarifications);
        if (draft.decision) setDecision(draft.decision);
        setClarificationDirection(DEFAULT_CLARIFICATION_DIRECTION);
        setClarificationConstraints("");
        setClarificationAnswers("");
        setPhase1Result(draft.phase1Result);
        if (draft.phase2Result) setPhase2Result(draft.phase2Result);
        setWorkflowStep(draft.workflowStep);
        setConversation(buildConversationFromDraft(draft));
      }
    }
  }, []);

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
    const hasMissingInventory = AGENT_CLI_OPTIONS.some(
      (alias) => !cliModelInventoryLoaded[alias]
    );
    if (!hasMissingInventory) return;
    const hasLoading = AGENT_CLI_OPTIONS.some(
      (alias) => cliModelInventoryLoading[alias]
    );
    if (hasLoading) return;
    void refreshCliModelInventory(AGENT_CLI_OPTIONS);
  }, [settingsOpen, cliSetupRequired, cliModelInventoryLoaded, cliModelInventoryLoading]);

  useEffect(() => {
    const hasLoading = AGENT_CLI_OPTIONS.some(
      (alias) => cliModelInventoryLoading[alias]
    );
    if (hasLoading) return;
    void refreshCliModelInventory(AGENT_CLI_OPTIONS);
  }, [cliCommandsSignature, ollamaHost]);

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
    if (
      clarificationDirectionOptions.some(
        (option) => option.value === clarificationDirection,
      )
    ) {
      return;
    }
    setClarificationDirection(DEFAULT_CLARIFICATION_DIRECTION);
  }, [clarificationDirection, clarificationDirectionOptions]);

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
    scrollAnchorRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  }, [conversation.length, isBusy]);

  useEffect(() => {
    if (promptModelAgentIds.length === 0) return;
    if (promptModelAgentIds.includes(activePromptModelAgentId))
      return;
    setActivePromptModelAgentId(promptModelAgentIds[0]);
  }, [activePromptModelAgentId, promptModelAgentIds]);

  let composerAccessory: JSX.Element | null = null;

  if (workflowStep === "decision" && phase2Result) {
    const p2Agents = phase2AgentsFromResult(phase2Result, phase12AgentsSafe);
    composerAccessory = (
      <MultiPlanArbitrationCard
        plans={p2Agents}
        disabled={isBusy}
        onInsertDecision={handleInsertDecisionTemplate}
      />
    );
  } else if (
    workflowStep === "phase3_config" ||
    workflowStep === "phase3_run"
  ) {
    composerAccessory = (
      <div className="chat-config-grid">
        <label className="grid gap-1">
          <span className="panel-label">Repository path</span>
          <input
            value={repoPath}
            onChange={(event) => {
              setRepoPath(event.target.value);
              setUnsavedState((prev) => ({ ...prev, phase3Dirty: true }));
            }}
            className="input-base"
            name="repo_path"
            autoComplete="off"
            spellCheck={false}
            placeholder="/absolute/path/to/git/repo"
          />
        </label>
        <label className="grid gap-1">
          <span className="panel-label">Base branch</span>
          <input
            value={baseBranch}
            onChange={(event) => {
              setBaseBranch(event.target.value);
              setUnsavedState((prev) => ({ ...prev, phase3Dirty: true }));
            }}
            className="input-base"
            name="base_branch"
            autoComplete="off"
            placeholder="main"
          />
        </label>
        <label className="checkbox-row chat-config-check">
          <input
            type="checkbox"
            checked={consentedToDataset}
            onChange={(event) => {
              setConsentedToDataset(event.target.checked);
              setUnsavedState((prev) => ({ ...prev, phase3Dirty: true }));
            }}
          />
          <span>Dataset opt-in</span>
        </label>
        {phase3FormError ? (
          <p
            className="text-xs font-medium text-friction-danger"
            role="alert"
            aria-live="polite"
          >
            {phase3FormError}
          </p>
        ) : null}
      </div>
    );
  }

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
                    <div className="aui-root friction-thread-surface friction-thread-surface-modern">
                      <Thread
                        welcome={{
                          message:
                            "Describe your requirement. I will run phase 1 automatically after you send.",
                        }}
                        composer={{ allowAttachments: false }}
                        userMessage={{ allowEdit: false }}
                        assistantMessage={{
                          allowReload: false,
                          allowCopy: true,
                          allowSpeak: false,
                          allowFeedbackPositive: false,
                          allowFeedbackNegative: false,
                          components: {
                            Text: MarkdownText,
                          },
                        }}
                        components={{
                          Composer: () => null,
                        }}
                        strings={{
                          composer: {
                            input: {
                              placeholder: PROMPT_HINTS[workflowStep],
                            },
                          },
                        }}
                      />
                    </div>
                    {artifactConversationItems.map((item) => {
                      if (item.type === "task") {
                        return (
                          <article key={item.id} className="chat-task-card">
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
                          const p1Agents = phase1AgentsFromResult(
                            p1,
                            phase12AgentsSafe,
                          );
                          return (
                            <PlanCard
                              key={item.id}
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
                          const p2Agents = phase2AgentsFromResult(
                            p2,
                            phase12AgentsSafe,
                          );
                          return (
                            <PlanCard
                              key={item.id}
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
                            key={item.id}
                            title="Phase 3 output"
                            summary={`Repo: ${item.payload.repoPath} · Branch: ${item.payload.baseBranch} · Confidence ${formatPercent(item.payload.phase3.confidenceScore)}`}
                          >
                            <DiffViewer phase3={item.payload.phase3} />
                          </CodeCard>
                        );
                      }

                      return null;
                    })}
                    {isBusy ? <ShimmerBlock lines={4} /> : null}
                  </ConversationShell>

                  {workflowStep === "clarifications" ? (
                    <aside
                      className={[
                        "clarification-side-panel",
                        clarificationPanelCollapsed ? "is-collapsed" : "",
                      ].join(" ")}
                      aria-label="Clarification helper panel"
                    >
                      <div className="clarification-side-panel-header">
                        <div>
                          <p className="panel-label">Clarification helper</p>
                          <p className="text-xs text-friction-muted">
                            Fill direction, constraints, and open-question
                            answers.
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          className="min-h-9 px-2.5"
                          onClick={() =>
                            setClarificationPanelCollapsed((value) => !value)
                          }
                          aria-expanded={!clarificationPanelCollapsed}
                        >
                          {clarificationPanelCollapsed ? (
                            <>
                              <ChevronLeft
                                className="h-4 w-4"
                                aria-hidden="true"
                              />
                              Open
                            </>
                          ) : (
                            <>
                              <ChevronRight
                                className="h-4 w-4"
                                aria-hidden="true"
                              />
                              Collapse
                            </>
                          )}
                        </Button>
                      </div>
                      {!clarificationPanelCollapsed ? (
                        <ClarificationHelper
                          direction={clarificationDirection}
                          directionOptions={clarificationDirectionOptions}
                          constraints={clarificationConstraints}
                          answers={clarificationAnswers}
                          questions={clarificationQuestions}
                          disabled={isBusy}
                          onDirectionChange={setClarificationDirection}
                          onConstraintsChange={setClarificationConstraints}
                          onAnswersChange={setClarificationAnswers}
                          onInsertTemplate={handleInsertClarificationTemplate}
                        />
                      ) : (
                        <p className="text-xs text-friction-muted">
                          Panel collapsed. Open it to complete clarification
                          fields.
                        </p>
                      )}
                    </aside>
                  ) : null}
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
