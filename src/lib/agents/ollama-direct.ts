import type { AgentPlan, AgentResponse } from "../types";

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    model?: string;
  }>;
}

function phase1Prompt(bias: "architect" | "pragmatist", requirement: string): string {
  const roleDesc =
    bias === "architect"
      ? "a senior software architect. Focus on system design, modularity, long-term maintainability, and robust failure handling."
      : "a pragmatic senior developer. Focus on fast delivery, minimal complexity, and practical tradeoffs.";

  return `You are ${roleDesc}

Analyze the following software requirement independently.

REQUIREMENT:
${requirement}

Respond ONLY with a valid JSON object using exactly these keys:
{
  "interpretation": "your interpretation of what needs to be built",
  "assumptions": ["assumption 1", "assumption 2"],
  "risks": ["risk 1", "risk 2"],
  "questions": ["clarifying question 1", "clarifying question 2"],
  "approach": "your recommended approach"
}`;
}

function phase2Prompt(
  bias: "architect" | "pragmatist",
  requirement: string,
  clarifications: string
): string {
  const roleDesc =
    bias === "architect"
      ? "a senior software architect. Prioritize robust architecture, clear interfaces, and incremental delivery."
      : "a pragmatic senior developer. Prioritize MVP delivery, practical stack choices, and minimal overhead.";

  return `You are ${roleDesc}

Create an implementation plan for this requirement.

REQUIREMENT:
${requirement}

CLARIFICATIONS:
${clarifications || "None provided."}

Respond ONLY with a valid JSON object using exactly these keys:
{
  "stack": ["technology 1", "technology 2"],
  "phases": [
    {"name": "phase name", "duration": "Xd", "tasks": ["task 1", "task 2"]}
  ],
  "architecture": "architectural overview",
  "tradeoffs": ["tradeoff 1", "tradeoff 2"],
  "warnings": ["warning 1", "warning 2"]
}`;
}

async function generate(host: string, model: string, prompt: string): Promise<string> {
  const url = `${host.replace(/\/$/, "")}/api/generate`;
  let response: Response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false, format: "json" })
    });
  } catch (networkError) {
    const msg = networkError instanceof Error ? networkError.message : "Network error";
    throw new Error(
      `Cannot reach Ollama at ${host}. Make sure Ollama is running and CORS is allowed (OLLAMA_ORIGINS=*). Details: ${msg}`
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Ollama returned ${response.status}: ${text || response.statusText}`);
  }

  const data = (await response.json()) as { response?: string };
  return data.response ?? "";
}

export async function ollamaListModels(host: string): Promise<string[]> {
  const url = `${host.replace(/\/$/, "")}/api/tags`;
  let response: Response;

  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" }
    });
  } catch (networkError) {
    const msg = networkError instanceof Error ? networkError.message : "Network error";
    throw new Error(
      `Cannot reach Ollama at ${host}. Make sure Ollama is running and CORS is allowed (OLLAMA_ORIGINS=*). Details: ${msg}`
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Ollama returned ${response.status}: ${text || response.statusText}`);
  }

  const payload = (await response.json()) as OllamaTagsResponse;
  const names = (payload.models ?? [])
    .map((item) => (typeof item.name === "string" ? item.name : item.model))
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());

  return Array.from(new Set(names));
}

function parseAgentResponse(raw: string): AgentResponse {
  let parsed: Partial<AgentResponse> = {};
  try {
    parsed = JSON.parse(raw) as Partial<AgentResponse>;
  } catch {
    // best-effort extraction if JSON is malformed
  }

  return {
    interpretation: typeof parsed.interpretation === "string" && parsed.interpretation.trim() ? parsed.interpretation : "",
    assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions.map(String).filter(Boolean) : [],
    risks: Array.isArray(parsed.risks) ? parsed.risks.map(String).filter(Boolean) : [],
    questions: Array.isArray(parsed.questions) ? parsed.questions.map(String).filter(Boolean) : [],
    approach: typeof parsed.approach === "string" && parsed.approach.trim() ? parsed.approach : ""
  };
}

function parseAgentPlan(raw: string): AgentPlan {
  let parsed: Partial<AgentPlan> = {};
  try {
    parsed = JSON.parse(raw) as Partial<AgentPlan>;
  } catch {
    // best-effort
  }

  return {
    problemRead:
      typeof (parsed as { problemRead?: string; problem_read?: string }).problemRead === "string" &&
      (parsed as { problemRead?: string }).problemRead?.trim()
        ? (parsed as { problemRead: string }).problemRead
        : typeof (parsed as { problem_read?: string }).problem_read === "string" &&
            (parsed as { problem_read: string }).problem_read.trim()
          ? (parsed as { problem_read: string }).problem_read
          : "",
    mainHypothesis:
      typeof (parsed as { mainHypothesis?: string; main_hypothesis?: string }).mainHypothesis === "string" &&
      (parsed as { mainHypothesis?: string }).mainHypothesis?.trim()
        ? (parsed as { mainHypothesis: string }).mainHypothesis
        : typeof (parsed as { main_hypothesis?: string }).main_hypothesis === "string" &&
            (parsed as { main_hypothesis: string }).main_hypothesis.trim()
          ? (parsed as { main_hypothesis: string }).main_hypothesis
          : "",
    strategy: typeof parsed.strategy === "string" && parsed.strategy.trim() ? parsed.strategy : "",
    nextSteps:
      Array.isArray((parsed as { nextSteps?: unknown[] }).nextSteps)
        ? (parsed as { nextSteps: unknown[] }).nextSteps.map(String)
        : Array.isArray((parsed as { next_steps?: unknown[] }).next_steps)
          ? (parsed as { next_steps: unknown[] }).next_steps.map(String)
          : [],
    risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : [],
    openQuestions:
      Array.isArray((parsed as { openQuestions?: unknown[] }).openQuestions)
        ? (parsed as { openQuestions: unknown[] }).openQuestions.map(String)
        : Array.isArray((parsed as { open_questions?: unknown[] }).open_questions)
          ? (parsed as { open_questions: unknown[] }).open_questions.map(String)
          : [],
    stack: Array.isArray(parsed.stack) ? parsed.stack.map(String) : [],
    phases: Array.isArray(parsed.phases)
      ? parsed.phases.map((p) => ({
          name: typeof (p as { name?: string }).name === "string" ? (p as { name: string }).name : "Phase",
          duration: typeof (p as { duration?: string }).duration === "string" ? (p as { duration: string }).duration : "?",
          tasks: Array.isArray((p as { tasks?: unknown[] }).tasks)
            ? (p as { tasks: unknown[] }).tasks.map(String)
            : []
        }))
      : [],
    architecture: typeof parsed.architecture === "string" && parsed.architecture.trim() ? parsed.architecture : "",
    tradeoffs: Array.isArray(parsed.tradeoffs) ? parsed.tradeoffs.map(String) : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : []
  };
}

export async function ollamaAnalyzeRequirement(
  host: string,
  model: string,
  bias: "architect" | "pragmatist",
  requirement: string
): Promise<AgentResponse> {
  const raw = await generate(host, model, phase1Prompt(bias, requirement));
  return parseAgentResponse(raw);
}

export async function ollamaBuildPlan(
  host: string,
  model: string,
  bias: "architect" | "pragmatist",
  requirement: string,
  clarifications: string
): Promise<AgentPlan> {
  const raw = await generate(host, model, phase2Prompt(bias, requirement, clarifications));
  return parseAgentPlan(raw);
}
