import { Check, ChevronRight, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Terminal,
  TerminalContent,
  TerminalHeader,
  TerminalTitle,
} from "@/components/ai-elements/terminal";
import { useTheme } from "@/components/ThemeProvider";
import type { CliTimelineCommand, CliTimelineRun } from "@/lib/types";

interface CommandTimelineCardProps {
  run: CliTimelineRun;
}

function runStatusText(run: CliTimelineRun): string {
  if (run.status === "running") return "En cours";
  if (run.status === "failed") return "Échec";
  return "Terminé";
}

function commandTimelineStatus(command: CliTimelineCommand): string {
  if (command.status === "running") return "en cours";
  if (command.status === "failed") return "échoué";
  if (typeof command.exitCode === "number") return `terminé (code ${command.exitCode})`;
  return "terminé";
}

function commandActionText(command: CliTimelineCommand): string {
  const resolved = command.command?.trim();
  if (resolved) {
    return resolved;
  }
  const cli = command.cli?.trim();
  return cli ? `${cli} run` : "command";
}

function commandTitle(command: CliTimelineCommand): string {
  const agent = command.agentLabel?.trim() || command.agentId?.trim() || "Command";
  const cli = command.cli?.trim();
  return cli ? `${agent} · ${cli}` : agent;
}

function commandMeta(command: CliTimelineCommand): string {
  const parts: string[] = [];
  if (command.command?.trim()) {
    parts.push(command.command.trim());
  }
  if (command.commandSource?.trim()) {
    parts.push(`(${command.commandSource.trim()})`);
  }
  if (command.model?.trim()) {
    parts.push(`model=${command.model.trim()}`);
  }
  return parts.join(" ");
}

function shouldAutoOpen(command: CliTimelineCommand): boolean {
  return command.status === "running" || command.status === "failed";
}

export function CommandTimelineCard({ run }: CommandTimelineCardProps) {
  const { theme } = useTheme();
  const [openByCommandId, setOpenByCommandId] = useState<Record<string, boolean>>({});
  const [outputModeByCommandId, setOutputModeByCommandId] = useState<
    Record<string, "readable" | "raw">
  >({});
  const previousStatusesRef = useRef<Record<string, CliTimelineCommand["status"]>>({});

  useEffect(() => {
    setOpenByCommandId((previous) => {
      const next = { ...previous };
      let changed = false;
      const liveCommandIds = new Set<string>();

      run.commands.forEach((command) => {
        const commandId = command.commandId;
        liveCommandIds.add(commandId);
        const desiredOpen = shouldAutoOpen(command);
        const previousStatus = previousStatusesRef.current[commandId];
        const hasOpenValue = Object.prototype.hasOwnProperty.call(next, commandId);

        if (!hasOpenValue) {
          next[commandId] = desiredOpen;
          changed = true;
          return;
        }

        if (
          previousStatus &&
          previousStatus !== command.status &&
          (command.status === "running" ||
            command.status === "failed" ||
            (previousStatus === "running" && command.status === "finished"))
        ) {
          if (next[commandId] !== desiredOpen) {
            next[commandId] = desiredOpen;
            changed = true;
          }
        }
      });

      Object.keys(next).forEach((commandId) => {
        if (!liveCommandIds.has(commandId)) {
          delete next[commandId];
          changed = true;
        }
      });

      return changed ? next : previous;
    });

    setOutputModeByCommandId((previous) => {
      const next = { ...previous };
      let changed = false;
      const liveCommandIds = new Set(run.commands.map((command) => command.commandId));
      Object.keys(next).forEach((commandId) => {
        if (!liveCommandIds.has(commandId)) {
          delete next[commandId];
          changed = true;
        }
      });
      return changed ? next : previous;
    });

    const nextStatuses: Record<string, CliTimelineCommand["status"]> = {};
    run.commands.forEach((command) => {
      nextStatuses[command.commandId] = command.status;
    });
    previousStatusesRef.current = nextStatuses;
  }, [run.commands]);

  const terminalTone = theme === "dark" ? "dark" : "light";

  return (
    <section className={`codex-activity-block ${theme === "dark" ? "is-dark" : ""}`}>
      <p className="codex-activity-title">Phase {run.phase} · Exécution CLI · {runStatusText(run)}</p>
      {run.commands.length === 0 ? (
        <p className="codex-activity-muted">
          {run.status === "running" ? "Waiting for command output..." : "No output captured."}
        </p>
      ) : null}
      <div className="codex-activity-body">
        {run.commands.map((command, index) => {
          const commandId = command.commandId;
          const isOpen = openByCommandId[commandId] ?? shouldAutoOpen(command);
          const actionText = commandActionText(command);
          const displayMode =
            outputModeByCommandId[commandId] ?? command.displayMode ?? "readable";
          const selectedOutput =
            displayMode === "raw"
              ? command.rawOutput || command.output
              : command.readableOutput || command.output;
          const terminalOutput = selectedOutput
            ? selectedOutput
            : command.status === "running"
              ? "Waiting for command output...\n"
              : "No output captured.\n";

          return (
            <section
              key={`${run.requestId}-${command.commandId}-${index}`}
              className="codex-command-log"
            >
              <button
                type="button"
                className="codex-command-log-summary"
                aria-expanded={isOpen}
                onClick={() => {
                  setOpenByCommandId((previous) => ({
                    ...previous,
                    [commandId]: !isOpen,
                  }));
                }}
              >
                <div className="codex-command-log-main">
                  <p className="codex-command-log-title">
                    Terminal d'arrière-plan {commandTimelineStatus(command)} avec{" "}
                    <code>{actionText}</code>
                  </p>
                  <p className="codex-command-log-subtitle">{index + 1}. {commandTitle(command)}</p>
                </div>
                <ChevronRight
                  className={`codex-command-log-chevron h-4 w-4 ${isOpen ? "is-open" : ""}`}
                  aria-hidden="true"
                />
              </button>
              {isOpen ? (
                <div className="codex-command-log-content">
                <div className="codex-command-log-toolbar">
                  {commandMeta(command) || command.resolvedPath ? (
                    <p className="codex-command-log-meta">
                      {commandMeta(command)}
                      {commandMeta(command) && command.resolvedPath ? " · " : ""}
                      {command.resolvedPath}
                    </p>
                  ) : (
                    <div />
                  )}
                  <div
                    className="codex-command-output-toggle"
                    role="tablist"
                    aria-label="Output view mode"
                  >
                    <button
                      type="button"
                      className={
                        displayMode === "readable"
                          ? "is-active"
                          : ""
                      }
                      onClick={() =>
                        setOutputModeByCommandId((previous) => ({
                          ...previous,
                          [commandId]: "readable",
                        }))
                      }
                    >
                      Readable
                    </button>
                    <button
                      type="button"
                      className={displayMode === "raw" ? "is-active" : ""}
                      onClick={() =>
                        setOutputModeByCommandId((previous) => ({
                          ...previous,
                          [commandId]: "raw",
                        }))
                      }
                    >
                      Raw
                    </button>
                  </div>
                </div>
                <Terminal
                  tone={terminalTone}
                  className={`codex-terminal-surface codex-terminal-compact ${terminalTone === "dark" ? "codex-terminal-surface-dark" : "codex-terminal-surface-light"}`}
                  output={terminalOutput}
                  autoScroll={command.status === "running"}
                  isStreaming={command.status === "running"}
                >
                  <TerminalHeader className="codex-terminal-header codex-terminal-header-compact">
                    <div className="min-w-0 flex-1">
                      <TerminalTitle className="codex-terminal-title">Bash</TerminalTitle>
                    </div>
                    <div
                      className={`codex-terminal-status-chip codex-terminal-status-chip-${command.status}`}
                    >
                      {command.status === "running" ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      ) : command.status === "failed" ? (
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      <span>
                        {command.status === "running"
                          ? "En cours"
                          : command.status === "failed"
                            ? "Échec"
                            : "Réussite"}
                      </span>
                    </div>
                  </TerminalHeader>
                  <TerminalContent className="h-40 codex-terminal-content codex-terminal-content-compact" />
                </Terminal>
              </div>
              ) : null}
            </section>
          );
        })}
      </div>
      {run.status === "failed" && run.error ? (
        <p className="codex-activity-error">{run.error}</p>
      ) : null}
    </section>
  );
}
