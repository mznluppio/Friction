"use client";

import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorLogoGroup,
  ModelSelectorName,
} from "@/components/ai-elements/model-selector";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import {
  buildCliAliasModelGroups,
  CLI_ALIAS_ORDER,
  CLI_ALIAS_LABEL,
} from "@/lib/model-catalog";
import type {
  AgentCli,
  AgentCliModelMap,
  AgentCliModelPerAgentMap,
  CliAliasModelInventory,
  PhaseAgentRuntime,
  WorkflowStep,
} from "@/lib/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CheckIcon, ChevronDownIcon, CpuIcon, PlusIcon, XIcon } from "lucide-react";
import {
  type ChangeEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";

// ─── CLI provider slug mapping ────────────────────────────────────────────────
const CLI_PROVIDER_SLUG: Record<AgentCli, string> = {
  opencode: "opencode",
  claude: "anthropic",
  codex: "openai",
  gemini: "google",
};

// Judge provider → logo slug
const JUDGE_PROVIDER_SLUG: Record<string, string> = {
  haiku: "anthropic",
  flash: "google",
  ollama: "lmstudio",
};

const JUDGE_PROVIDER_LABEL: Record<string, string> = {
  haiku: "Haiku",
  flash: "Flash",
  ollama: "Ollama",
};

// ─── Types ────────────────────────────────────────────────────────────────────
interface DisplayAgent {
  id: string;
  label: string;
  cli: AgentCli;
  removable: boolean;
}

interface WorkflowPromptInputProps {
  value: string;
  disabled?: boolean;
  placeholder: string;
  accessory?: ReactNode;
  onChange: (value: string) => void;
  onSubmit: () => void;
  workflowStep: WorkflowStep;
  phase12Agents: PhaseAgentRuntime[];
  phase3AgentACli: AgentCli;
  phase3AgentBCli: AgentCli;
  onAddPhase12Agent: () => void;
  onRemovePhase12Agent: (agentId: string) => void;
  onAgentCliChange: (agentId: string, cli: AgentCli) => void;
  activePromptModelAgentId: string;
  onActivePromptModelAgentChange: (agentId: string) => void;
  agentCliModels: AgentCliModelPerAgentMap;
  cliModels: AgentCliModelMap;
  cliModelInventory: Partial<Record<AgentCli, CliAliasModelInventory>>;
  cliModelInventoryLoading: Partial<Record<AgentCli, boolean>>;
  cliModelInventoryLoaded: Partial<Record<AgentCli, boolean>>;
  onRequestCliModelInventory: (
    aliases?: AgentCli[],
    options?: { forceRefresh?: boolean },
  ) => void | Promise<void>;
  opencodeModels: string[];
  onAgentCliModelChange: (agentId: string, value: string) => void;
  judgeProvider?: string;
  judgeModel?: string;
  onJudgeProviderChange?: (provider: any) => void;
  onJudgeModelChange?: (model: string) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function buildPhase12DisplayAgents(agents: PhaseAgentRuntime[]): DisplayAgent[] {
  return agents.slice(0, 4).map((agent, index) => ({
    id: agent.id,
    label: `${["A", "B", "C", "D"][index] ?? "?"}`,
    cli: agent.cli,
    removable: index >= 2,
  }));
}

function isPhase3WorkflowStep(step: WorkflowStep): boolean {
  return step === "phase3_config" || step === "phase3_run" || step === "completed";
}

function shortModelName(model: string): string {
  if (!model) return "default";
  // Strip provider prefix like "anthropic/" or "openai/"
  const idx = model.lastIndexOf("/");
  const name = idx >= 0 ? model.slice(idx + 1) : model;
  return name.length > 22 ? name.slice(0, 20) + "…" : name;
}

// ─── Main Component ───────────────────────────────────────────────────────────
export function WorkflowPromptInput({
  value,
  disabled,
  placeholder,
  accessory,
  onChange,
  onSubmit,
  workflowStep,
  phase12Agents,
  phase3AgentACli,
  phase3AgentBCli,
  onAddPhase12Agent,
  onRemovePhase12Agent,
  onAgentCliChange,
  activePromptModelAgentId,
  onActivePromptModelAgentChange,
  agentCliModels,
  cliModels,
  cliModelInventory,
  cliModelInventoryLoading,
  cliModelInventoryLoaded,
  onRequestCliModelInventory,
  opencodeModels,
  onAgentCliModelChange,
  judgeProvider,
  judgeModel,
  onJudgeProviderChange,
  onJudgeModelChange,
}: WorkflowPromptInputProps) {
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const [judgeSelectorOpen, setJudgeSelectorOpen] = useState(false);
  const [customModelDraft, setCustomModelDraft] = useState("");
  const [customTargetCli, setCustomTargetCli] = useState<AgentCli>("opencode");

  const phase3Scope = isPhase3WorkflowStep(workflowStep);
  const displayAgents = useMemo<DisplayAgent[]>(() => {
    if (phase3Scope) {
      return [
        { id: "phase3_agent_a", label: "A", cli: phase3AgentACli, removable: false },
        { id: "phase3_agent_b", label: "B", cli: phase3AgentBCli, removable: false },
      ];
    }
    return buildPhase12DisplayAgents(phase12Agents);
  }, [phase3Scope, phase12Agents, phase3AgentACli, phase3AgentBCli]);

  const activeAgent =
    displayAgents.find((a) => a.id === activePromptModelAgentId) ??
    displayAgents[0] ??
    null;

  useEffect(() => {
    if (!activeAgent) return;
    if (activeAgent.id === activePromptModelAgentId) return;
    onActivePromptModelAgentChange(activeAgent.id);
  }, [activeAgent, activePromptModelAgentId, onActivePromptModelAgentChange]);

  useEffect(() => {
    if (!activeAgent) return;
    const scoped = (agentCliModels[activeAgent.id] ?? "").trim();
    setCustomModelDraft(scoped);
    setCustomTargetCli(activeAgent.cli);
  }, [activeAgent, agentCliModels]);

  // Load model inventory whenever selector opens
  useEffect(() => {
    if (!modelSelectorOpen) return;
    const aliases = CLI_ALIAS_ORDER.filter((alias) => !cliModelInventoryLoading[alias]);
    if (aliases.length === 0) return;
    void Promise.resolve(onRequestCliModelInventory(aliases));
  }, [modelSelectorOpen, cliModelInventoryLoading, onRequestCliModelInventory]);

  const activeResolvedModel = activeAgent
    ? (agentCliModels[activeAgent.id] ?? "").trim() ||
    (cliModels[activeAgent.cli] ?? "").trim()
    : "";

  const cliGroups = useMemo(
    () =>
      buildCliAliasModelGroups({
        inventory: cliModelInventory,
        opencodeModels,
        includeFallbackPresetsWhenMissing: false,
      }),
    [cliModelInventory, opencodeModels],
  );

  const canSubmit = !disabled && value.trim().length > 0;
  const canAddPhase12Agent = !phase3Scope && phase12Agents.length < 4;

  function groupHeading(group: (typeof cliGroups)[number]): string {
    if (!cliModelInventoryLoaded[group.alias]) return `${group.label}`;
    if (group.source === "fallback") return `${group.label} (fallback)`;
    if (group.source === "cache" && group.stale) {
      return `${group.label} (refreshing…)`;
    }
    return group.label;
  }

  function handlePromptSubmit(message: PromptInputMessage) {
    if (!message.text?.trim()) return;
    onSubmit();
  }

  function openSelectorForAgent(agentId: string) {
    onActivePromptModelAgentChange(agentId);
    setModelSelectorOpen(true);
  }

  return (
    <section className="chat-composer-wrap" aria-label="Prompt composer">
      {accessory ? <div className="chat-composer-accessory">{accessory}</div> : null}

      {/* Model selector dialog — rendered outside PromptInput so z-index is independent */}
      <ModelSelector open={modelSelectorOpen} onOpenChange={setModelSelectorOpen}>
        <ModelSelectorContent
          className="workflow-model-selector-content"
          title={
            activeAgent
              ? `Select model — Agent ${activeAgent.label} (${CLI_ALIAS_LABEL[activeAgent.cli]})`
              : "Select model"
          }
        >
          {/* Header */}
          <div className="workflow-model-selector-header">
            <div className="workflow-model-selector-header-left">
              <CpuIcon className="size-4 text-friction-muted" />
              <div>
                <p className="text-sm font-semibold text-friction-text leading-none">
                  {activeAgent
                    ? `Agent ${activeAgent.label} — ${CLI_ALIAS_LABEL[activeAgent.cli]}`
                    : "Select model"}
                </p>
                {activeAgent ? (
                  <p className="mt-0.5 text-xs text-friction-muted">
                    Current:{" "}
                    <span className="font-medium text-friction-text">
                      {shortModelName(activeResolvedModel) || "default"}
                    </span>
                  </p>
                ) : null}
              </div>
            </div>
          </div>

          {/* Search */}
          <ModelSelectorInput placeholder="Search models…" />

          {/* Model list */}
          <ModelSelectorList>
            <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
            {cliGroups.map((group) => (
              <ModelSelectorGroup heading={groupHeading(group)} key={group.alias}>
                {/* Default option */}
                <ModelSelectorItem
                  key={`${group.alias}-default`}
                  value={`${group.alias}::__default__`}
                  onSelect={() => {
                    if (!activeAgent) return;
                    onAgentCliChange(activeAgent.id, group.alias);
                    onAgentCliModelChange(activeAgent.id, "");
                    setModelSelectorOpen(false);
                  }}
                >
                  <ModelSelectorLogo provider={group.providerSlug} />
                  <ModelSelectorName>{group.label} — default</ModelSelectorName>
                  {activeAgent &&
                    activeAgent.cli === group.alias &&
                    !(agentCliModels[activeAgent.id] ?? "").trim() ? (
                    <CheckIcon className="ml-auto size-4 text-friction-text" />
                  ) : (
                    <div className="ml-auto size-4" />
                  )}
                </ModelSelectorItem>

                {/* Loading state */}
                {!cliModelInventoryLoaded[group.alias] ? (
                  <ModelSelectorItem
                    key={`${group.alias}:__loading__`}
                    value={`${group.alias}:__loading__`}
                    disabled
                  >
                    <span className="text-friction-muted text-xs">
                      Loading live models…
                    </span>
                  </ModelSelectorItem>
                ) : null}

                {/* Live models */}
                {cliModelInventoryLoaded[group.alias]
                  ? group.options.map((model) => (
                    <ModelSelectorItem
                      key={`${group.alias}:${model.id}`}
                      value={`${group.alias}:${model.id}`}
                      onSelect={() => {
                        if (!activeAgent) return;
                        onAgentCliChange(activeAgent.id, group.alias);
                        onAgentCliModelChange(activeAgent.id, model.id);
                        setModelSelectorOpen(false);
                      }}
                    >
                      <ModelSelectorLogo provider={group.providerSlug} />
                      <ModelSelectorName>{model.name}</ModelSelectorName>
                      <ModelSelectorLogoGroup>
                        {(model.providers ?? [group.providerSlug]).map((p) => (
                          <ModelSelectorLogo
                            key={`${group.alias}:${model.id}:${p}`}
                            provider={p}
                          />
                        ))}
                      </ModelSelectorLogoGroup>
                      {activeAgent &&
                        activeAgent.cli === group.alias &&
                        (
                          (agentCliModels[activeAgent.id] ?? "").trim() ||
                          (cliModels[group.alias] ?? "").trim()
                        ) === model.id ? (
                        <CheckIcon className="ml-auto size-4 text-friction-text" />
                      ) : (
                        <div className="ml-auto size-4" />
                      )}
                    </ModelSelectorItem>
                  ))
                  : null}
              </ModelSelectorGroup>
            ))}
          </ModelSelectorList>

          {/* Fallback reasons */}
          {cliGroups.some(
            (g) => cliModelInventoryLoaded[g.alias] && g.source === "fallback" && g.reason,
          ) ? (
            <div className="workflow-model-selector-reasons">
              {cliGroups
                .filter(
                  (g) =>
                    cliModelInventoryLoaded[g.alias] &&
                    g.source === "fallback" &&
                    g.reason,
                )
                .map((g) => (
                  <p key={`reason:${g.alias}`} className="text-[11px] text-friction-muted">
                    {g.label}: {g.reason}
                  </p>
                ))}
            </div>
          ) : null}

          {/* Custom model entry */}
          <div className="workflow-model-selector-custom">
            <select
              value={customTargetCli}
              onChange={(e) => setCustomTargetCli(e.target.value as AgentCli)}
              className="workflow-model-selector-custom-target"
            >
              <option value="opencode">OpenCode</option>
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
              <option value="gemini">Gemini</option>
            </select>
            <input
              value={customModelDraft}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setCustomModelDraft(e.target.value)
              }
              placeholder="Custom model id…"
              className="workflow-model-selector-custom-input"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="workflow-model-selector-custom-apply"
              onClick={() => {
                if (!activeAgent) return;
                onAgentCliChange(activeAgent.id, customTargetCli);
                onAgentCliModelChange(activeAgent.id, customModelDraft);
                setModelSelectorOpen(false);
              }}
            >
              Apply
            </button>
          </div>
        </ModelSelectorContent>
      </ModelSelector>

      {/* Judge dedicated selector */}
      <ModelSelector open={judgeSelectorOpen} onOpenChange={setJudgeSelectorOpen}>
        <ModelSelectorContent className="workflow-model-selector-content" title="Select Judge AI">
          <div className="workflow-model-selector-header">
            <div className="workflow-model-selector-header-left">
              <CpuIcon className="size-4 text-friction-muted" />
              <div>
                <p className="text-sm font-semibold text-friction-text leading-none">
                  Select Judge AI
                </p>
                <p className="mt-0.5 text-xs text-friction-muted">
                  Current: <span className="font-medium text-friction-text">{judgeModel || JUDGE_PROVIDER_LABEL[judgeProvider || ""] || "default"}</span>
                </p>
              </div>
            </div>
          </div>

          <ModelSelectorList>
            <ModelSelectorGroup heading="Recommended Evaluate Models">
              {/* Haiku */}
              <ModelSelectorItem
                value="anthropic::claude-3-5-haiku-20241022"
                onSelect={() => {
                  onJudgeProviderChange?.("haiku");
                  onJudgeModelChange?.("claude-3-5-haiku-20241022");
                  setJudgeSelectorOpen(false);
                }}
              >
                <ModelSelectorLogo provider="anthropic" />
                <ModelSelectorName>Claude 3.5 Haiku</ModelSelectorName>
                {judgeModel === "claude-3-5-haiku-20241022" || judgeProvider === "haiku" ? (
                  <CheckIcon className="ml-auto size-4 text-friction-text" />
                ) : (
                  <div className="ml-auto size-4" />
                )}
              </ModelSelectorItem>

              {/* Flash */}
              <ModelSelectorItem
                value="google::gemini-2.5-flash"
                onSelect={() => {
                  onJudgeProviderChange?.("flash");
                  onJudgeModelChange?.("gemini-2.5-flash");
                  setJudgeSelectorOpen(false);
                }}
              >
                <ModelSelectorLogo provider="google" />
                <ModelSelectorName>Gemini 2.5 Flash</ModelSelectorName>
                {judgeModel === "gemini-2.5-flash" || judgeProvider === "flash" ? (
                  <CheckIcon className="ml-auto size-4 text-friction-text" />
                ) : (
                  <div className="ml-auto size-4" />
                )}
              </ModelSelectorItem>

              {/* Ollama */}
              <ModelSelectorItem
                value="ollama::llama3.2"
                onSelect={() => {
                  onJudgeProviderChange?.("ollama");
                  onJudgeModelChange?.("llama3.2");
                  setJudgeSelectorOpen(false);
                }}
              >
                <ModelSelectorLogo provider="lmstudio" />
                <ModelSelectorName>Llama 3.2 (Ollama)</ModelSelectorName>
                {judgeModel === "llama3.2" || judgeProvider === "ollama" ? (
                  <CheckIcon className="ml-auto size-4 text-friction-text" />
                ) : (
                  <div className="ml-auto size-4" />
                )}
              </ModelSelectorItem>
            </ModelSelectorGroup>
          </ModelSelectorList>
        </ModelSelectorContent>
      </ModelSelector>

      {/* Prompt input — ai-elements style */}
      <TooltipProvider>
        <PromptInputProvider>
          <PromptInput onSubmit={handlePromptSubmit}>

            {/* Textarea */}
            <PromptInputBody>
              <PromptInputTextarea
                value={value}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange(e.currentTarget.value)}
                placeholder={placeholder}
                disabled={disabled}
              />
            </PromptInputBody>

            {/* Footer */}
            <PromptInputFooter className="workflow-prompt-footer">
              <PromptInputTools className="workflow-prompt-tools">
                <div className="workflow-prompt-tools-scroll">
                  {/* Judge chip — clickable, opens provider picker */}
                  {judgeProvider ? (
                    <div className="workflow-agent-chip-wrap">
                      <button
                        type="button"
                        className="workflow-judge-chip workflow-judge-chip-btn"
                        aria-label="Change judge provider"
                        onClick={() => setJudgeSelectorOpen(true)}
                      >
                        <ModelSelectorLogo
                          provider={JUDGE_PROVIDER_SLUG[judgeProvider] ?? "anthropic"}
                          className="size-3 flex-none"
                        />
                        <span className="workflow-judge-chip-label">Judge</span>
                        <span className="workflow-agent-chip-sep">·</span>
                        <span className="workflow-agent-chip-model">
                          {judgeModel
                            ? shortModelName(judgeModel)
                            : JUDGE_PROVIDER_LABEL[judgeProvider] ?? judgeProvider}
                        </span>
                        <ChevronDownIcon className="size-3 flex-none text-friction-muted" />
                      </button>
                    </div>
                  ) : null}
                  {displayAgents.map((agent) => {
                    const resolvedModel =
                      (agentCliModels[agent.id] ?? "").trim() ||
                      (cliModels[agent.cli] ?? "").trim();
                    return (
                      <div key={agent.id} className="workflow-agent-chip-wrap">
                        <button
                          type="button"
                          className={["workflow-agent-chip"].join(" ")}
                          onClick={() => openSelectorForAgent(agent.id)}
                        >
                          <ModelSelectorLogo
                            provider={CLI_PROVIDER_SLUG[agent.cli]}
                            className="size-3 flex-none"
                          />
                          <span className="workflow-agent-chip-label">
                            Agent {agent.label}
                          </span>
                          <span className="workflow-agent-chip-sep">·</span>
                          <span className="workflow-agent-chip-model">
                            {shortModelName(resolvedModel)}
                          </span>
                          <ChevronDownIcon className="size-3 flex-none text-friction-muted" />
                        </button>

                        {!phase3Scope && agent.removable ? (
                          <button
                            type="button"
                            className="workflow-agent-chip-remove"
                            onClick={() => onRemovePhase12Agent(agent.id)}
                            aria-label={`Remove Agent ${agent.label}`}
                          >
                            <XIcon className="size-3" />
                          </button>
                        ) : null}
                      </div>
                    );
                  })}

                  {canAddPhase12Agent ? (
                    <button
                      type="button"
                      className="workflow-agent-chip-add"
                      onClick={onAddPhase12Agent}
                      aria-label="Add agent"
                    >
                      <PlusIcon className="size-3.5" />
                      <span className="text-xs">Add agent</span>
                    </button>
                  ) : null}
                </div>
              </PromptInputTools>

              <PromptInputSubmit disabled={!canSubmit} />
            </PromptInputFooter>
          </PromptInput>
        </PromptInputProvider>
      </TooltipProvider>
    </section>
  );
}
