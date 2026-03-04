import * as Dialog from "@radix-ui/react-dialog";
import { ChevronDown, RotateCw, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ollamaListModels } from "../lib/agents/ollama-direct";
import { getModelOptionIdsForCli } from "../lib/model-catalog";
import type {
  AgentCli,
  AgentCliCommandMap,
  CliAliasModelInventory,
  AgentCliModelPerAgentMap,
  AgentCliModelMap,
  CliOnboardingStatus,
  JudgeProvider,
  PhaseAgentRuntime
} from "../lib/types";
import { Button } from "./ui/button";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  judgeProviderOptions: readonly JudgeProvider[];
  phase12Agents: PhaseAgentRuntime[];
  phase3AgentACli: AgentCli;
  phase3AgentBCli: AgentCli;
  cliCommands: AgentCliCommandMap;
  agentCliModels: AgentCliModelPerAgentMap;
  // Legacy global fallback kept for compatibility with older snapshots.
  cliModels: AgentCliModelMap;
  cliModelInventory: Partial<Record<AgentCli, CliAliasModelInventory>>;
  opencodeModels: string[];
  opencodeModelsLoading: boolean;
  opencodeModelsError: string | null;
  cliCommandStatuses: CliOnboardingStatus[];
  cliDiagnosticsLoading: boolean;
  cliDiagnosticsError: string | null;
  judgeProvider: JudgeProvider;
  judgeModel: string;
  ollamaHost: string;
  autoCleanup: boolean;
  onPhase12AgentsChange: (value: PhaseAgentRuntime[]) => void;
  onPhase3AgentACliChange: (value: AgentCli) => void;
  onPhase3AgentBCliChange: (value: AgentCli) => void;
  onJudgeProviderChange: (value: JudgeProvider) => void;
  onJudgeModelChange: (value: string) => void;
  onOllamaHostChange: (value: string) => void;
  onAutoCleanupChange: (value: boolean) => void;
  onCliCommandChange: (cli: AgentCli, value: string) => void;
  onAgentCliModelChange: (agentId: string, value: string) => void;
  onCliModelChange: (cli: AgentCli, value: string) => void;
  onRefreshOpencodeModels: () => void;
  onRerunCliOnboarding?: () => void;
  onResetRuntimeSettings: () => void;
}

interface SettingsGroupProps {
  title: string;
  description?: string;
  children: ReactNode;
}

const AGENT_SLOTS: { id: string; label: string; defaultCli: AgentCli }[] = [
  { id: "agent_a", label: "Agent A · Architect", defaultCli: "claude" },
  { id: "agent_b", label: "Agent B · Pragmatist", defaultCli: "codex" },
  { id: "agent_c", label: "Agent C · Challenger", defaultCli: "gemini" },
  { id: "agent_d", label: "Agent D · Operator", defaultCli: "claude" }
];

const AGENT_CLI_OPTIONS: AgentCli[] = ["claude", "codex", "gemini", "opencode"];

function SettingsGroup({ title, description, children }: SettingsGroupProps) {
  return (
    <section className="settings-group">
      <div>
        <h3 className="text-sm font-semibold text-friction-text">{title}</h3>
        {description ? <p className="mt-1 text-xs text-friction-muted">{description}</p> : null}
      </div>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function normalizedPhaseAgents(agents: PhaseAgentRuntime[], count: number): PhaseAgentRuntime[] {
  const clamped = Math.max(2, Math.min(4, count));
  return AGENT_SLOTS.slice(0, clamped).map((slot, index) => ({
    id: agents[index]?.id ?? slot.id,
    label: agents[index]?.label ?? slot.label,
    cli: agents[index]?.cli ?? slot.defaultCli
  }));
}

function selectedPhase12CliAliases(agents: PhaseAgentRuntime[]): AgentCli[] {
  const aliases: AgentCli[] = [];
  agents.slice(0, 2).forEach((agent) => {
    if (!aliases.includes(agent.cli)) {
      aliases.push(agent.cli);
    }
  });
  return aliases;
}

export function SettingsDialog({
  open,
  onOpenChange,
  judgeProviderOptions,
  phase12Agents,
  phase3AgentACli,
  phase3AgentBCli,
  cliCommands,
  agentCliModels,
  cliModels,
  cliModelInventory,
  opencodeModels,
  opencodeModelsLoading,
  opencodeModelsError,
  cliCommandStatuses,
  cliDiagnosticsLoading,
  cliDiagnosticsError,
  judgeProvider,
  judgeModel,
  ollamaHost,
  autoCleanup,
  onPhase12AgentsChange,
  onPhase3AgentACliChange,
  onPhase3AgentBCliChange,
  onJudgeProviderChange,
  onJudgeModelChange,
  onOllamaHostChange,
  onAutoCleanupChange,
  onCliCommandChange,
  onAgentCliModelChange,
  onCliModelChange,
  onRefreshOpencodeModels,
  onRerunCliOnboarding,
  onResetRuntimeSettings
}: SettingsDialogProps) {
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaModelsLoading, setOllamaModelsLoading] = useState(false);
  const [ollamaModelsError, setOllamaModelsError] = useState<string | null>(null);

  const phaseAgentCount = Math.max(2, Math.min(4, phase12Agents.length));
  const normalizedAgents = normalizedPhaseAgents(phase12Agents, phaseAgentCount);
  const selectedAliases = selectedPhase12CliAliases(normalizedAgents);
  const needsOllamaModels = judgeProvider === "ollama";

  const aliasModelPresets = useMemo<Record<AgentCli, string[]>>(() => {
    return AGENT_CLI_OPTIONS.reduce((acc, cli) => {
      acc[cli] = getModelOptionIdsForCli(cli, opencodeModels);
      return acc;
    }, {} as Record<AgentCli, string[]>);
  }, [opencodeModels]);

  async function refreshOllamaModels() {
    const host = ollamaHost.trim() || "http://localhost:11434";
    setOllamaModelsLoading(true);
    setOllamaModelsError(null);
    try {
      const models = await ollamaListModels(host);
      setOllamaModels(models);
      if (models.length === 0) {
        setOllamaModelsError(`No Ollama models found on ${host}.`);
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Unknown error";
      setOllamaModels([]);
      setOllamaModelsError(message);
    } finally {
      setOllamaModelsLoading(false);
    }
  }

  useEffect(() => {
    if (!open || !needsOllamaModels) return;
    const timer = window.setTimeout(() => {
      void refreshOllamaModels();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [open, needsOllamaModels, ollamaHost]);

  useEffect(() => {
    if (!open || judgeProvider !== "ollama" || ollamaModels.length === 0) return;
    if (!ollamaModels.includes(judgeModel)) {
      onJudgeModelChange(ollamaModels[0]);
    }
  }, [open, judgeProvider, judgeModel, ollamaModels, onJudgeModelChange]);

  function agentModelValueFor(agentId: string, cli: AgentCli): string {
    const scoped = agentCliModels[agentId];
    if (typeof scoped === "string" && scoped.trim().length > 0) {
      return scoped;
    }
    return cliModels[cli] ?? "";
  }

  function modelInventoryHint(cli: AgentCli): string {
    const inventory = cliModelInventory[cli];
    if (!inventory) {
      return "Model inventory: loading...";
    }
    if (inventory.reason?.trim()) {
      return `Model inventory: ${inventory.source} (${inventory.reason.trim()})`;
    }
    return `Model inventory: ${inventory.source}.`;
  }

  function renderAgentRuntimeRow(args: {
    title: string;
    agentId: string;
    cli: AgentCli;
    onCliChange: (cli: AgentCli) => void;
    cliSelectName: string;
    modelInputName: string;
  }) {
    const { title, agentId, cli, onCliChange, cliSelectName, modelInputName } = args;
    const datalistId = `settings-model-presets-${agentId}`;
    return (
      <div className="grid gap-2 rounded-lg border border-friction-border bg-friction-surface p-3">
        <label className="grid gap-1">
          <span className="panel-label">{title}</span>
          <select
            value={cli}
            onChange={(event) => onCliChange(event.target.value as AgentCli)}
            className="select-base"
            name={cliSelectName}
          >
            {AGENT_CLI_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label className="grid gap-1">
          <span className="panel-label">Model (optional)</span>
          <input
            value={agentModelValueFor(agentId, cli)}
            onChange={(event) => onAgentCliModelChange(agentId, event.target.value)}
            list={datalistId}
            placeholder="Leave empty to use CLI default"
            className="input-base"
            name={modelInputName}
            autoComplete="off"
            spellCheck={false}
          />
          <datalist id={datalistId}>
            {aliasModelPresets[cli].map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
          <p className="text-xs text-friction-muted" role="status">
            Resolution: <code>agent_cli_models.{agentId}</code> → <code>cli_models.{cli}</code> → CLI default.
          </p>
          <p className="text-xs text-friction-muted" role="status">
            {modelInventoryHint(cli)}
          </p>
        </label>
      </div>
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[1px]" />
        <Dialog.Content className="settings-dialog-panel">
          <header className="flex items-start justify-between gap-3 border-b border-friction-border pb-3">
            <div>
              <Dialog.Title className="text-base font-semibold text-friction-text">Runtime settings</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-friction-muted">
                Simplified controls: choose CLI + model per agent, then run.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="btn btn-ghost min-h-9 px-2.5" aria-label="Close settings">
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </Dialog.Close>
          </header>

          <div className="settings-dialog-body">
            <SettingsGroup title="Phase 1/2 Agents" description="Agent count + CLI/model per agent for analysis/planning.">
              <label className="grid gap-1">
                <span className="panel-label">Phase 1/2 agent count</span>
                <select
                  value={phaseAgentCount}
                  onChange={(event) => {
                    const count = Number(event.target.value);
                    onPhase12AgentsChange(normalizedPhaseAgents(phase12Agents, count));
                  }}
                  className="select-base"
                  name="phase_agent_count"
                >
                  <option value={2}>2 agents</option>
                  <option value={3}>3 agents</option>
                  <option value={4}>4 agents</option>
                </select>
              </label>

              <div className="grid gap-2">
                {normalizedAgents.map((agent, index) => {
                  const title =
                    index === 0
                      ? "Agent A CLI (phase 1/2)"
                      : index === 1
                        ? "Agent B CLI (phase 1/2)"
                        : agent.label;
                  return (
                    <div key={agent.id}>
                      {renderAgentRuntimeRow({
                        title,
                        agentId: agent.id,
                        cli: agent.cli,
                        onCliChange: (cli) => {
                          const next = normalizedPhaseAgents(phase12Agents, phaseAgentCount);
                          next[index] = { ...next[index], cli };
                          onPhase12AgentsChange(next);
                        },
                        cliSelectName: `phase_agent_cli_${index}`,
                        modelInputName: `phase_agent_model_${agent.id}`
                      })}
                    </div>
                  );
                })}
              </div>

              <p className="text-xs text-friction-muted" role="status">
                Next Phase 1/2 run: {normalizedAgents.map((agent) => `${agent.id}=${agent.cli}`).join(" · ")}
              </p>
            </SettingsGroup>

            <SettingsGroup title="Phase 3 Agents" description="Dedicated CLI/model per codegen and reviewer.">
              {renderAgentRuntimeRow({
                title: "Phase 3 Agent A",
                agentId: "phase3_agent_a",
                cli: phase3AgentACli,
                onCliChange: onPhase3AgentACliChange,
                cliSelectName: "phase3_agent_a_cli",
                modelInputName: "phase3_agent_a_model"
              })}
              {renderAgentRuntimeRow({
                title: "Phase 3 Agent B",
                agentId: "phase3_agent_b",
                cli: phase3AgentBCli,
                onCliChange: onPhase3AgentBCliChange,
                cliSelectName: "phase3_agent_b_cli",
                modelInputName: "phase3_agent_b_model"
              })}
              <p className="text-xs text-friction-muted" role="status">
                Next Phase 3 run: agent_a={phase3AgentACli} · agent_b={phase3AgentBCli}
              </p>
            </SettingsGroup>

            <SettingsGroup title="CLI Commands & Models" description="Runtime command path + model diagnostics for selected Agent A/B aliases.">
              <div className="grid gap-2 rounded-lg border border-friction-border bg-friction-surface p-3">
                <p className="panel-label">CLI command overrides (selected Agent A/B)</p>
                {selectedAliases.map((cli) => {
                  const status = cliCommandStatuses.find((item) => item.cli === cli);
                  return (
                    <label key={`cli_command_${cli}`} className="grid gap-1">
                      <span className="panel-label">{cli} command</span>
                      <input
                        value={cliCommands[cli] ?? ""}
                        onChange={(event) => onCliCommandChange(cli, event.target.value)}
                        placeholder={cli}
                        className="input-base"
                        name={`cli_command_${cli}`}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <p className="text-xs text-friction-muted" role="status">
                        {status
                          ? `resolved='${status.resolvedCommand || "n/a"}' (${status.source || "n/a"}) · path=${status.resolvedPath || "not found"}`
                          : "No diagnostic result yet."}
                      </p>
                      <p className="text-xs text-friction-muted" role="status">
                        {status
                          ? `model='${status.resolvedModel?.trim() || "default"}' (${status.resolvedModelSource?.trim() || "default"})`
                          : "Model diagnostics unavailable."}
                      </p>
                      <p
                        className={`text-xs ${status?.isExecutable && status?.isReady ? "text-friction-muted" : "text-friction-danger"}`}
                        role="status"
                      >
                        {status?.detail ?? "No diagnostic result yet."}
                      </p>
                    </label>
                  );
                })}

                {cliDiagnosticsLoading ? (
                  <p className="text-xs text-friction-muted" role="status">
                    Checking selected CLI executables…
                  </p>
                ) : null}
                {cliDiagnosticsError ? (
                  <p className="text-xs text-friction-danger" role="status">
                    {cliDiagnosticsError}
                  </p>
                ) : null}
              </div>

              <div className="grid gap-2 rounded-lg border border-friction-border bg-friction-surface p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="panel-label">OpenCode models</p>
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-9 px-3"
                    onClick={onRefreshOpencodeModels}
                    disabled={opencodeModelsLoading}
                  >
                    <RotateCw className={["h-4 w-4", opencodeModelsLoading ? "animate-spin" : ""].join(" ")} />
                    {opencodeModelsLoading ? "Refreshing…" : "Refresh"}
                  </Button>
                </div>
                {opencodeModelsError ? (
                  <p className="text-xs text-friction-danger" role="status">
                    {opencodeModelsError}
                  </p>
                ) : (
                  <p className="text-xs text-friction-muted" role="status">
                    {opencodeModels.length} model{opencodeModels.length > 1 ? "s" : ""} found.
                  </p>
                )}
              </div>

              <details className="rounded-lg border border-friction-border bg-friction-surface p-3">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-semibold text-friction-text">
                  <span>Advanced fallback models (legacy alias-level)</span>
                  <ChevronDown className="h-4 w-4 text-friction-muted" aria-hidden="true" />
                </summary>
                <div className="mt-3 grid gap-2">
                  {AGENT_CLI_OPTIONS.map((cli) => {
                    const datalistId = `settings-legacy-model-${cli}`;
                    return (
                      <label key={`cli_model_${cli}`} className="grid gap-1">
                        <span className="panel-label">{cli} fallback model</span>
                        <input
                          value={cliModels[cli] ?? ""}
                          onChange={(event) => onCliModelChange(cli, event.target.value)}
                          list={datalistId}
                          placeholder="Optional fallback model"
                          className="input-base"
                          name={`cli_model_${cli}`}
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <datalist id={datalistId}>
                          {aliasModelPresets[cli].map((model) => (
                            <option key={model} value={model} />
                          ))}
                        </datalist>
                      </label>
                    );
                  })}
                </div>
              </details>
            </SettingsGroup>

            <SettingsGroup title="Runtime & Judge" description="Validation scorer, host, and runtime safety controls.">
              <div className="grid gap-2 md:grid-cols-2">
                <label className="grid gap-1">
                  <span className="panel-label">Judge provider</span>
                  <select
                    value={judgeProvider}
                    onChange={(event) => onJudgeProviderChange(event.target.value as JudgeProvider)}
                    className="select-base"
                    name="judge_provider"
                  >
                    {judgeProviderOptions.map((provider) => (
                      <option key={provider} value={provider}>
                        {provider}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="grid gap-1">
                  <span className="panel-label">Judge model</span>
                  {judgeProvider === "ollama" && ollamaModels.length > 0 ? (
                    <select
                      value={judgeModel}
                      onChange={(event) => onJudgeModelChange(event.target.value)}
                      className="select-base"
                      name="judge_model"
                    >
                      {ollamaModels.map((modelName) => (
                        <option key={modelName} value={modelName}>
                          {modelName}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={judgeModel}
                      onChange={(event) => onJudgeModelChange(event.target.value)}
                      placeholder={judgeProvider === "ollama" ? "Load models from Ollama API" : "auto"}
                      className="input-base"
                      name="judge_model"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  )}
                </label>
              </div>

              <label className="grid gap-1">
                <span className="panel-label">Ollama host</span>
                <input
                  value={ollamaHost}
                  onChange={(event) => onOllamaHostChange(event.target.value)}
                  className="input-base"
                  name="ollama_host"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>

              {needsOllamaModels ? (
                <div className="grid gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    className="justify-start"
                    onClick={() => void refreshOllamaModels()}
                    disabled={ollamaModelsLoading}
                  >
                    {ollamaModelsLoading ? "Loading Ollama models..." : "Refresh Ollama model list"}
                  </Button>
                  {ollamaModelsError ? (
                    <p className="text-xs text-friction-danger" role="status">
                      {ollamaModelsError}
                    </p>
                  ) : null}
                  {!ollamaModelsError && ollamaModels.length > 0 ? (
                    <p className="text-xs text-friction-muted" role="status">
                      {ollamaModels.length} model{ollamaModels.length > 1 ? "s" : ""} found.
                    </p>
                  ) : null}
                </div>
              ) : null}

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={autoCleanup}
                  onChange={(event) => onAutoCleanupChange(event.target.checked)}
                />
                <span>Auto cleanup worktrees</span>
              </label>

              <div className="grid gap-2 md:grid-cols-2">
                <Button
                  type="button"
                  variant="danger"
                  className="justify-start"
                  onClick={onResetRuntimeSettings}
                >
                  Reset runtime settings
                </Button>
                {onRerunCliOnboarding ? (
                  <Button type="button" variant="ghost" className="justify-start" onClick={onRerunCliOnboarding}>
                    Re-run CLI onboarding
                  </Button>
                ) : null}
              </div>
            </SettingsGroup>
          </div>

          <footer className="mt-4 border-t border-friction-border pt-3">
            <Dialog.Close asChild>
              <Button variant="ghost" className="w-full">
                Done
              </Button>
            </Dialog.Close>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
