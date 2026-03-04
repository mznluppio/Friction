import type { AgentCli, CliAliasModelInventory } from "./types";

export type ProviderSlug =
  | "openai"
  | "anthropic"
  | "google"
  | "opencode"
  | "ollama"
  | "other";

export interface AgentModelOption {
  id: string;
  name: string;
  provider: string;
  providerSlug: ProviderSlug;
  providers?: string[];
}

export interface AgentModelGroup {
  provider: string;
  providerSlug: ProviderSlug;
  options: AgentModelOption[];
}

export interface CliAliasModelGroup {
  alias: AgentCli;
  label: string;
  providerSlug: ProviderSlug;
  source: "live" | "cache" | "fallback";
  stale?: boolean;
  reason?: string;
  options: AgentModelOption[];
}

const PROVIDER_ORDER: ProviderSlug[] = [
  "openai",
  "anthropic",
  "google",
  "opencode",
  "ollama",
  "other",
];

const PROVIDER_LABEL: Record<ProviderSlug, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  opencode: "OpenCode",
  ollama: "Ollama",
  other: "Other",
};

export const CLI_ALIAS_ORDER: AgentCli[] = [
  "opencode",
  "claude",
  "codex",
  "gemini",
];

export const CLI_ALIAS_LABEL: Record<AgentCli, string> = {
  opencode: "OpenCode",
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
};

export const CLI_ALIAS_PROVIDER_SLUG: Record<AgentCli, ProviderSlug> = {
  opencode: "opencode",
  claude: "anthropic",
  codex: "openai",
  gemini: "google",
};

const BASE_MODELS: Record<AgentCli, AgentModelOption[]> = {
  claude: [
    {
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      provider: "Anthropic",
      providerSlug: "anthropic",
      providers: ["anthropic"],
    },
    {
      id: "claude-sonnet-4",
      name: "Claude Sonnet 4",
      provider: "Anthropic",
      providerSlug: "anthropic",
      providers: ["anthropic"],
    },
    {
      id: "claude-opus-4-1",
      name: "Claude Opus 4.1",
      provider: "Anthropic",
      providerSlug: "anthropic",
      providers: ["anthropic"],
    },
  ],
  codex: [
    {
      id: "gpt-5-codex",
      name: "GPT-5 Codex",
      provider: "OpenAI",
      providerSlug: "openai",
      providers: ["openai"],
    },
    {
      id: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      provider: "OpenAI",
      providerSlug: "openai",
      providers: ["openai"],
    },
    {
      id: "o4-mini",
      name: "o4-mini",
      provider: "OpenAI",
      providerSlug: "openai",
      providers: ["openai"],
    },
  ],
  gemini: [
    {
      id: "gemini-2.5-pro",
      name: "Gemini 2.5 Pro",
      provider: "Google",
      providerSlug: "google",
      providers: ["google"],
    },
    {
      id: "gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      provider: "Google",
      providerSlug: "google",
      providers: ["google"],
    },
  ],
  opencode: [
    {
      id: "openai/gpt-5-codex",
      name: "OpenAI / GPT-5 Codex",
      provider: "OpenAI",
      providerSlug: "openai",
      providers: ["opencode", "openai"],
    },
    {
      id: "ollama/llama3.2",
      name: "Ollama / llama3.2",
      provider: "Ollama",
      providerSlug: "ollama",
      providers: ["opencode", "ollama"],
    },
  ],
};

function inferProviderFromToken(token: string): ProviderSlug {
  const value = token.trim().toLowerCase();
  if (!value) return "other";
  if (value.includes("openai") || value.startsWith("gpt") || value.startsWith("o4")) {
    return "openai";
  }
  if (value.includes("anthropic") || value.startsWith("claude")) {
    return "anthropic";
  }
  if (value.includes("google") || value.startsWith("gemini")) {
    return "google";
  }
  if (value.includes("ollama")) {
    return "ollama";
  }
  if (value.includes("opencode")) {
    return "opencode";
  }
  return "other";
}

function makeDynamicOpencodeModelOption(modelId: string): AgentModelOption | null {
  const id = modelId.trim();
  if (!id) return null;

  const [providerToken, modelToken] = id.includes("/") ? id.split("/", 2) : ["", id];
  const inferred = inferProviderFromToken(providerToken || modelToken);
  const provider = PROVIDER_LABEL[inferred];
  const providers = inferred === "opencode" ? ["opencode"] : ["opencode", inferred];
  const name = modelToken ? `${provider} / ${modelToken}` : id;

  return {
    id,
    name,
    provider,
    providerSlug: inferred,
    providers,
  };
}

export function getModelCatalogForCli(cli: AgentCli, opencodeModels: string[] = []): AgentModelOption[] {
  const base = BASE_MODELS[cli] ?? [];
  if (cli !== "opencode") {
    return [...base];
  }

  const dynamic = opencodeModels
    .map(makeDynamicOpencodeModelOption)
    .filter((item): item is AgentModelOption => item !== null);

  const merged = [...base, ...dynamic];
  const deduped = new Map<string, AgentModelOption>();
  merged.forEach((item) => {
    if (!deduped.has(item.id)) {
      deduped.set(item.id, item);
    }
  });
  return Array.from(deduped.values());
}

export function getModelOptionIdsForCli(cli: AgentCli, opencodeModels: string[] = []): string[] {
  return getModelCatalogForCli(cli, opencodeModels).map((item) => item.id);
}

export function getModelGroupsForCli(cli: AgentCli, opencodeModels: string[] = []): AgentModelGroup[] {
  const catalog = getModelCatalogForCli(cli, opencodeModels);
  const groups = new Map<ProviderSlug, AgentModelOption[]>();

  catalog.forEach((item) => {
    const bucket = groups.get(item.providerSlug) ?? [];
    bucket.push(item);
    groups.set(item.providerSlug, bucket);
  });

  return PROVIDER_ORDER
    .filter((providerSlug) => groups.has(providerSlug))
    .map((providerSlug) => {
      const options = (groups.get(providerSlug) ?? []).sort((a, b) => a.name.localeCompare(b.name));
      return {
        provider: PROVIDER_LABEL[providerSlug],
        providerSlug,
        options,
      };
    });
}

function makeModelOptionFromId(id: string, cli: AgentCli): AgentModelOption {
  const trimmed = id.trim();
  const baseForCli = BASE_MODELS[cli] ?? [];
  const preset = baseForCli.find((item) => item.id === trimmed);
  if (preset) {
    return preset;
  }

  if (cli === "opencode") {
    const dynamic = makeDynamicOpencodeModelOption(trimmed);
    if (dynamic) {
      return dynamic;
    }
  }

  return {
    id: trimmed,
    name: trimmed,
    provider: CLI_ALIAS_LABEL[cli],
    providerSlug: CLI_ALIAS_PROVIDER_SLUG[cli],
    providers: [CLI_ALIAS_PROVIDER_SLUG[cli]],
  };
}

export function buildCliAliasModelGroups(args: {
  inventory: Partial<Record<AgentCli, CliAliasModelInventory>>;
  opencodeModels?: string[];
  includeFallbackPresetsWhenMissing?: boolean;
}): CliAliasModelGroup[] {
  const includeFallbackPresetsWhenMissing =
    args.includeFallbackPresetsWhenMissing ?? true;

  return CLI_ALIAS_ORDER.map((alias) => {
    const inventoryEntry = args.inventory[alias];
    const source = inventoryEntry?.source ?? "fallback";
    const stale = inventoryEntry?.stale ?? false;
    const reason = inventoryEntry?.reason;
    const models = inventoryEntry?.models && inventoryEntry.models.length > 0
      ? inventoryEntry.models
      : includeFallbackPresetsWhenMissing
        ? getModelOptionIdsForCli(alias, args.opencodeModels ?? [])
        : [];

    const options = Array.from(
      new Map(
        models
          .map((modelId) => modelId.trim())
          .filter(Boolean)
          .map((modelId) => [modelId, makeModelOptionFromId(modelId, alias)])
      ).values()
    ).sort((a, b) => a.name.localeCompare(b.name));

    return {
      alias,
      label: CLI_ALIAS_LABEL[alias],
      providerSlug: CLI_ALIAS_PROVIDER_SLUG[alias],
      source,
      stale,
      reason,
      options,
    };
  });
}
