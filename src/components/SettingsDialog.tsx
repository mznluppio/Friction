import * as Dialog from "@radix-ui/react-dialog";
import { RotateCw, X } from "lucide-react";
import type { ReactNode } from "react";
import type {
  AgentCli,
  AgentCliCommandMap,
  CliOnboardingStatus,
} from "../lib/types";
import { Button } from "./ui/button";
import { ThemeToggle } from "./ThemeProvider";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cliCommands: AgentCliCommandMap;
  opencodeModels: string[];
  opencodeModelsLoading: boolean;
  opencodeModelsError: string | null;
  cliCommandStatuses: CliOnboardingStatus[];
  cliDiagnosticsLoading: boolean;
  cliDiagnosticsError: string | null;
  ollamaHost: string;
  autoCleanup: boolean;
  onOllamaHostChange: (value: string) => void;
  onAutoCleanupChange: (value: boolean) => void;
  onCliCommandChange: (cli: AgentCli, value: string) => void;
  onRefreshOpencodeModels: () => void;
  onRerunCliOnboarding?: () => void;
  onResetRuntimeSettings: () => void;
}

interface SettingsGroupProps {
  title: string;
  description?: string;
  children: ReactNode;
}

const AGENT_CLI_OPTIONS: AgentCli[] = ["claude", "codex", "gemini", "opencode"];

function getInstallCommand(cli: AgentCli): string {
  switch (cli) {
    case "claude":
      return "npm install -g @anthropic-ai/claude-code";
    case "codex":
      return "npm install -g @openai/codex-cli";
    case "gemini":
      return "npm install -g @google/geminicli";
    case "opencode":
      return "npm install -g opencode";
    default:
      return "";
  }
}

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

export function SettingsDialog({
  open,
  onOpenChange,
  cliCommands,
  opencodeModels,
  opencodeModelsLoading,
  opencodeModelsError,
  cliCommandStatuses,
  cliDiagnosticsLoading,
  cliDiagnosticsError,
  ollamaHost,
  autoCleanup,
  onOllamaHostChange,
  onAutoCleanupChange,
  onCliCommandChange,
  onRefreshOpencodeModels,
  onRerunCliOnboarding,
  onResetRuntimeSettings
}: SettingsDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[1px]" />
        <Dialog.Content className="settings-dialog-panel">
          <header className="flex items-start justify-between gap-3 border-b border-friction-border pb-3">
            <div>
              <Dialog.Title className="text-base font-semibold text-friction-text">Friction Settings</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-friction-muted">
                System preferences and CLI configuration overrides.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="btn btn-ghost min-h-9 px-2.5" aria-label="Close settings">
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </Dialog.Close>
          </header>

          <div className="settings-dialog-body">
            <SettingsGroup title="Appearance">
              <div className="flex items-center justify-between gap-2 rounded-lg border border-friction-border bg-friction-surface p-3">
                <span className="panel-label">Color Theme</span>
                <ThemeToggle />
              </div>
            </SettingsGroup>

            <SettingsGroup title="CLI Commands & Diagnostics" description="Runtime command path + model diagnostics.">
              <div className="grid gap-2 rounded-lg border border-friction-border bg-friction-surface p-3">
                <p className="panel-label">CLI command overrides</p>
                {AGENT_CLI_OPTIONS.map((cli) => {
                  const status = cliCommandStatuses.find((item) => item.cli === cli);
                  return (
                    <label key={`cli_command_${cli}`} className="grid gap-1">
                      <span className="panel-label">{cli}</span>
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
                      <p
                        className={`text-xs ${status?.isExecutable && status?.isReady ? "text-friction-muted" : "text-friction-danger"}`}
                        role="status"
                      >
                        {status?.detail ?? "No diagnostic result yet."}
                      </p>
                      {status && !status.isExecutable ? (
                        <div className="mt-1 flex items-center gap-2 rounded-md border border-friction-border bg-friction-surface p-2">
                          <code className="flex-1 text-[11px] text-friction-text">{getInstallCommand(cli)}</code>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-16 text-[10px]"
                            onClick={() => navigator.clipboard.writeText(getInstallCommand(cli))}
                          >
                            Copy
                          </Button>
                        </div>
                      ) : null}
                    </label>
                  );
                })}

                {cliDiagnosticsLoading ? (
                  <p className="text-xs text-friction-muted" role="status">
                    Checking CLI executables…
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
            </SettingsGroup>

            <SettingsGroup title="System Preferences" description="Local daemon and artifact options.">
              <label className="grid gap-1">
                <span className="panel-label">Ollama host (used locally)</span>
                <input
                  value={ollamaHost}
                  onChange={(event) => onOllamaHostChange(event.target.value)}
                  className="input-base"
                  name="ollama_host"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={autoCleanup}
                  onChange={(event) => onAutoCleanupChange(event.target.checked)}
                />
                <span>Auto cleanup execution worktrees</span>
              </label>

              <div className="grid gap-2 md:grid-cols-2 mt-2">
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
