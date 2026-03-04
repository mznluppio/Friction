import type { AgentPlan, AgentResponse, LLMAgent } from "../types";

export class ClaudeAgent implements LLMAgent {
  name = "claude-sonnet-4";
  bias: LLMAgent["bias"] = "architect";

  constructor(private readonly apiKey?: string) {}

  async analyzeRequirement(_requirement: string): Promise<AgentResponse> {
    if (!this.apiKey) {
      throw new Error("ANTHROPIC_API_KEY is missing.");
    }
    throw new Error("ClaudeAgent not wired yet. Use backend command bridge.");
  }

  async buildPlan(_requirement: string, _clarifications: string): Promise<AgentPlan> {
    if (!this.apiKey) {
      throw new Error("ANTHROPIC_API_KEY is missing.");
    }
    throw new Error("ClaudeAgent not wired yet. Use backend command bridge.");
  }
}

export class GPT4Agent implements LLMAgent {
  name = "gpt-4o";
  bias: LLMAgent["bias"] = "pragmatist";

  constructor(private readonly apiKey?: string) {}

  async analyzeRequirement(_requirement: string): Promise<AgentResponse> {
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is missing.");
    }
    throw new Error("GPT4Agent not wired yet. Use backend command bridge.");
  }

  async buildPlan(_requirement: string, _clarifications: string): Promise<AgentPlan> {
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is missing.");
    }
    throw new Error("GPT4Agent not wired yet. Use backend command bridge.");
  }
}

export class OllamaAgent implements LLMAgent {
  name = "ollama-local";
  bias: LLMAgent["bias"] = "custom";

  constructor(private readonly host = "http://localhost:11434") {}

  async analyzeRequirement(_requirement: string): Promise<AgentResponse> {
    void this.host;
    throw new Error("OllamaAgent not wired yet. Use backend command bridge.");
  }

  async buildPlan(_requirement: string, _clarifications: string): Promise<AgentPlan> {
    void this.host;
    throw new Error("OllamaAgent not wired yet. Use backend command bridge.");
  }
}
