import { ChevronDown, Layers, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import type { AgentPlan, Divergence } from "../lib/types";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

interface PlanPanelProps {
  title: string;
  tone: "steel" | "ember";
  plan: AgentPlan;
  divergences: Divergence[];
}

export function PlanPanel({ title, tone, plan, divergences }: PlanPanelProps) {
  const [open, setOpen] = useState(true);
  const contentId = useId();
  const nextSteps = plan.nextSteps.length > 0
    ? plan.nextSteps
    : plan.phases.flatMap((phase) => phase.tasks);
  const risks = plan.risks.length > 0 ? plan.risks : plan.warnings;

  return (
    <Card>
      <CardHeader className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <CardTitle>{title}</CardTitle>
          <Badge tone={tone === "steel" ? "glow" : "ember"}>{nextSteps.length} next steps</Badge>
        </div>
        <button
          type="button"
          className="btn btn-ghost min-h-11 px-3"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronDown className={["h-4 w-4 transition-transform", open ? "rotate-180" : "rotate-0"].join(" ")} aria-hidden="true" />
          <span>{open ? "Collapse" : "Expand"}</span>
        </button>
      </CardHeader>

      <CardContent id={contentId} className={open ? "space-y-4" : "hidden"}>
        <section className="space-y-1">
          <h4 className="panel-label">Problem read</h4>
          <p className="text-sm text-friction-text">{plan.problemRead || plan.architecture}</p>
        </section>

        <section className="space-y-2">
          <h4 className="panel-label">Strategy</h4>
          <p className="text-sm text-friction-text">{plan.strategy || plan.architecture}</p>
        </section>

        <section className="space-y-2">
          <h4 className="panel-label">Main hypothesis</h4>
          <p className="text-sm text-friction-text">
            {plan.mainHypothesis || "No main hypothesis captured."}
          </p>
        </section>

        <section className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-xl border border-friction-border bg-friction-surfaceAlt p-3">
            <p className="panel-label flex items-center gap-2">
              <Layers className="h-3.5 w-3.5" aria-hidden="true" />
              Tradeoffs
            </p>
            <ul className="mt-2 space-y-1 text-sm text-friction-text">
              {plan.tradeoffs.map((item) => (
                <li key={item} className="break-words">
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-friction-border bg-friction-surfaceAlt p-3">
            <p className="panel-label flex items-center gap-2">
              <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />
              Risks
            </p>
            <ul className="mt-2 space-y-1 text-sm text-friction-text">
              {risks.map((item) => (
                <li key={item} className="break-words">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="space-y-2">
          <h4 className="panel-label">Next steps</h4>
          <ol className="space-y-1 text-sm text-friction-text">
            {nextSteps.map((step) => (
              <li key={step} className="flex gap-2">
                <span aria-hidden="true">•</span>
                <span className="min-w-0 break-words">{step}</span>
              </li>
            ))}
          </ol>
        </section>

        {plan.openQuestions.length > 0 ? (
          <section className="space-y-2">
            <h4 className="panel-label">Open questions</h4>
            <ul className="space-y-1 text-sm text-friction-text">
              {plan.openQuestions.map((item) => (
                <li key={item} className="break-words">
                  {item}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {divergences.length > 0 ? (
          <section className="rounded-xl border border-friction-border bg-friction-surfaceAlt p-3">
            <h4 className="panel-label">Divergence signals</h4>
            <ul className="mt-2 space-y-2 text-sm text-friction-text">
              {divergences.map((item, index) => (
                <li key={`${item.field}-${index}`} className="flex items-start gap-2 break-words">
                  <span aria-hidden="true">•</span>
                  <span>
                    <span className="font-semibold">{item.field}</span>: severity {item.severity}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}
