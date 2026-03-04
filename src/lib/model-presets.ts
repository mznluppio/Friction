import type { AgentCli } from "./types";

export const CLI_MODEL_PRESETS: Record<AgentCli, string[]> = {
  claude: ["claude-sonnet-4-5", "claude-sonnet-4", "claude-opus-4-1"],
  codex: ["gpt-5-codex", "gpt-5.3-codex", "o4-mini"],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash"],
  opencode: ["openai/gpt-5-codex", "ollama/llama3.2"],
};

export function getCliModelOptions(cli: AgentCli, opencodeModels: string[] = []): string[] {
  const base = CLI_MODEL_PRESETS[cli] ?? [];
  const runtimeOpencode =
    cli === "opencode"
      ? opencodeModels
          .map((value) => value.trim())
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b))
      : [];
  return Array.from(new Set([...base, ...runtimeOpencode]));
}
