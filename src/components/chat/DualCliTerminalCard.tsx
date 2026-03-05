import { ChevronRight } from "lucide-react";
import {
  Terminal,
  TerminalActions,
  TerminalContent,
  TerminalCopyButton,
  TerminalHeader,
  TerminalStatus,
  TerminalTitle,
} from "@/components/ai-elements/terminal";

export interface CliTerminalEntry {
  label: string;
  output: string;
  isStreaming?: boolean;
  command?: string;
  commandSource?: string;
  resolvedPath?: string;
  model?: string;
  modelSource?: string;
}

interface DualCliTerminalCardProps {
  title: string;
  summary: string;
  entries: CliTerminalEntry[];
  defaultOpen?: boolean;
}

const ANSI_COLORS = [36, 33, 35, 32];

function withTrimmed(value: string): string {
  return value.trim();
}

export function parsePhase12RuntimeTerminalEntries(detail?: string): CliTerminalEntry[] {
  const normalized = withTrimmed(detail ?? "");
  if (!normalized) return [];

  return normalized
    .split(/\r?\n/)
    .map((line) => withTrimmed(line))
    .filter((line) => line.length > 0)
    .map((line, index) => {
      const parsed = /^([^:]+):\s*(.*)$/.exec(line);
      const label = parsed?.[1] ? withTrimmed(parsed[1]) : `Agent ${index + 1}`;
      const body = parsed?.[2] ? parsed[2] : line;
      const color = ANSI_COLORS[index % ANSI_COLORS.length];
      const output = `\u001b[1;${color}m${label}\u001b[0m\n${body}\n`;
      return { label, output };
    });
}

export function DualCliTerminalCard({
  title,
  summary,
  entries,
  defaultOpen = false,
}: DualCliTerminalCardProps) {
  return (
    <details
      className="chat-collapsible-card chat-collapsible-card-terminal codex-runtime-card"
      open={defaultOpen}
    >
      <summary className="chat-collapsible-summary">
        <div>
          <p className="text-sm font-semibold text-friction-text">{title}</p>
          <p className="mt-1 text-xs text-friction-muted">{summary}</p>
        </div>
        <ChevronRight
          className="chat-collapsible-icon h-4 w-4 text-friction-muted"
          aria-hidden="true"
        />
      </summary>

      <div className="chat-collapsible-content">
        <div className="grid gap-4 2xl:grid-cols-2">
          {entries.map((entry, index) => (
            <Terminal
              tone="light"
              key={`${entry.label}-${index}`}
              output={entry.output}
              autoScroll={entry.isStreaming ?? false}
              isStreaming={entry.isStreaming ?? false}
            >
              <TerminalHeader>
                <div className="min-w-0 flex-1">
                  <TerminalTitle>{entry.label}</TerminalTitle>
                  {entry.command ? (
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-[11px] text-slate-400">
                      {entry.command}
                      {entry.commandSource ? ` (${entry.commandSource})` : ""}
                      {entry.model ? ` · model=${entry.model}` : ""}
                    </p>
                  ) : null}
                  {entry.resolvedPath ? (
                    <p className="whitespace-pre-wrap break-all text-[11px] text-slate-500">
                      {entry.resolvedPath}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <TerminalStatus />
                  <TerminalActions>
                    <TerminalCopyButton />
                  </TerminalActions>
                </div>
              </TerminalHeader>
              <TerminalContent className="h-56" />
            </Terminal>
          ))}
        </div>
      </div>
    </details>
  );
}
