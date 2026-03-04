import { Bot } from "lucide-react";
import type { AgentPlan, AgentResponse } from "../lib/types";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

type AgentPayload = AgentResponse | AgentPlan;

interface AgentCardProps {
  title: string;
  tone: "steel" | "ember";
  payload: AgentPayload;
  fields: string[];
  /** e.g. "ollama:llama3.2:latest" — shown in the header instead of "Isolated" */
  model?: string;
}

const fieldLabels: Record<string, string> = {
  interpretation: "Interpretation",
  assumptions: "Assumptions",
  risks: "Risks",
  questions: "Questions",
  approach: "Approach",
  stack: "Stack",
  phases: "Phases",
  architecture: "Architecture",
  tradeoffs: "Tradeoffs",
  warnings: "Warnings"
};

function isPlan(payload: AgentPayload): payload is AgentPlan {
  return "phases" in payload;
}

export function AgentCard({ title, tone, payload, fields, model }: AgentCardProps) {
  const badgeTone = tone === "steel" ? "glow" : "ember";

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <div>
          <CardTitle>{title}</CardTitle>
          {model && (
            <p className="mt-0.5 text-[11px] font-mono text-friction-muted">{model}</p>
          )}
        </div>
        <Badge tone={badgeTone}>
          <Bot className="h-3 w-3" aria-hidden="true" />
          Isolated
        </Badge>
      </CardHeader>

      <CardContent className="space-y-4">
        {fields.map((field) => (
          <section key={field}>
            <p className="panel-label">{fieldLabels[field] ?? field}</p>
            <FieldRenderer value={(payload as unknown as Record<string, unknown>)[field]} isPlan={isPlan(payload)} />
          </section>
        ))}
      </CardContent>
    </Card>
  );
}

function FieldRenderer({ value, isPlan }: { value: unknown; isPlan: boolean }) {
  if (Array.isArray(value)) {
    if (
      isPlan &&
      value.length > 0 &&
      typeof value[0] === "object" &&
      value[0] !== null &&
      "name" in (value[0] as Record<string, unknown>)
    ) {
      return (
        <div className="space-y-2">
          {(value as AgentPlan["phases"]).map((phase) => (
            <article key={phase.name} className="rounded-lg border border-friction-border bg-friction-surfaceAlt p-3">
              <p className="text-sm font-semibold text-friction-text">
                {phase.name} <span className="text-xs font-medium text-friction-muted">({phase.duration})</span>
              </p>
              <ul className="mt-2 space-y-1 text-sm text-friction-text">
                {phase.tasks.map((task) => (
                  <li key={task} className="flex gap-2">
                    <span aria-hidden="true">•</span>
                    <span>{task}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      );
    }

    return (
      <ul className="space-y-1 text-sm text-friction-text">
        {value.map((item) => (
          <li key={String(item)} className="rounded-md border border-friction-border bg-friction-surfaceAlt px-3 py-1.5">
            {String(item)}
          </li>
        ))}
      </ul>
    );
  }

  if (typeof value === "string") {
    return <p className="text-sm leading-relaxed text-friction-text">{value}</p>;
  }

  return <p className="text-sm text-friction-muted">N/A</p>;
}
