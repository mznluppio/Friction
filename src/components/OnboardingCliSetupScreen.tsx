import { Settings2 } from "lucide-react";
import type { AgentCli, AgentCliCommandMap, CliOnboardingStatus, PhaseAgentRuntime } from "../lib/types";
import { Button } from "./ui/button";

interface OnboardingCliSetupScreenProps {
  phase12Agents: PhaseAgentRuntime[];
  cliCommands: AgentCliCommandMap;
  cliCommandStatuses: CliOnboardingStatus[];
  cliDiagnosticsLoading: boolean;
  cliDiagnosticsError: string | null;
  canConfirmCliSetup: boolean;
  onPhase12AgentsChange: (value: PhaseAgentRuntime[]) => void;
  onCliCommandChange: (cli: AgentCli, value: string) => void;
  onConfirmCliSetup: () => void;
  onOpenAdvancedSettings: () => void;
}

const CLI_OPTIONS: AgentCli[] = ["claude", "codex", "gemini", "opencode"];

function selectedAliases(agents: PhaseAgentRuntime[]): AgentCli[] {
  const aliases: AgentCli[] = [];
  agents.slice(0, 2).forEach((agent) => {
    if (!aliases.includes(agent.cli)) {
      aliases.push(agent.cli);
    }
  });
  return aliases;
}

export function OnboardingCliSetupScreen({
  phase12Agents,
  cliCommands,
  cliCommandStatuses,
  cliDiagnosticsLoading,
  cliDiagnosticsError,
  canConfirmCliSetup,
  onPhase12AgentsChange,
  onCliCommandChange,
  onConfirmCliSetup,
  onOpenAdvancedSettings
}: OnboardingCliSetupScreenProps) {
  const agentA = phase12Agents[0];
  const agentB = phase12Agents[1];
  const aliases = selectedAliases(phase12Agents);

  return (
    <main className="onboarding-shell">
      <section className="onboarding-panel">
        <header className="space-y-2 border-b border-friction-border pb-4">
          <p className="panel-label">First-run setup</p>
          <h1 className="panel-title text-xl">Configure CLI runtime before first run</h1>
          <p className="panel-subtitle">
            Select Phase 1/2 Agent A and Agent B CLI, then confirm when both executables are detected.
          </p>
        </header>

        <div className="onboarding-body">
          <div className="onboarding-grid">
            <label className="grid gap-1">
              <span className="panel-label">Agent A CLI (phase 1/2)</span>
              <select
                value={agentA?.cli ?? "claude"}
                onChange={(event) => {
                  const next = [...phase12Agents];
                  next[0] = { ...next[0], cli: event.target.value as AgentCli };
                  onPhase12AgentsChange(next);
                }}
                className="select-base"
                name="onboarding_agent_a_cli"
              >
                {CLI_OPTIONS.map((cli) => (
                  <option key={cli} value={cli}>
                    {cli}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-1">
              <span className="panel-label">Agent B CLI (phase 1/2)</span>
              <select
                value={agentB?.cli ?? "codex"}
                onChange={(event) => {
                  const next = [...phase12Agents];
                  next[1] = { ...next[1], cli: event.target.value as AgentCli };
                  onPhase12AgentsChange(next);
                }}
                className="select-base"
                name="onboarding_agent_b_cli"
              >
                {CLI_OPTIONS.map((cli) => (
                  <option key={cli} value={cli}>
                    {cli}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid gap-2 rounded-xl border border-friction-border bg-friction-surface-alt p-3">
            <p className="panel-label">CLI command overrides (selected Agent A/B)</p>
            {aliases.map((cli) => {
              const status = cliCommandStatuses.find((item) => item.cli === cli);
              return (
                <label key={`onboarding_cli_command_${cli}`} className="grid gap-1">
                  <span className="panel-label">{cli} command</span>
                  <input
                    value={cliCommands[cli] ?? ""}
                    onChange={(event) => onCliCommandChange(cli, event.target.value)}
                    placeholder={cli}
                    className="input-base"
                    name={`onboarding_cli_command_${cli}`}
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

          <footer className="grid gap-2 border-t border-friction-border pt-3">
            <Button
              variant="primary"
              className="w-full"
              disabled={!canConfirmCliSetup}
              onClick={onConfirmCliSetup}
            >
              Confirm CLI setup
            </Button>
            {!canConfirmCliSetup ? (
              <p className="text-xs text-friction-danger" role="status">
                Selected Agent A/B commands must be executable and runtime-ready. Set an absolute path, run <code>codex login</code> when codex is selected, or switch to an installed CLI.
              </p>
            ) : null}
            <Button variant="ghost" className="w-full" onClick={onOpenAdvancedSettings}>
              <Settings2 className="h-4 w-4" aria-hidden="true" />
              Open advanced settings
            </Button>
          </footer>
        </div>
      </section>
    </main>
  );
}
