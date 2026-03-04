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

  return (
    <Card>
      <CardHeader className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <CardTitle>{title}</CardTitle>
          <Badge tone={tone === "steel" ? "glow" : "ember"}>{plan.stack.length} technologies</Badge>
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
          <h4 className="panel-label">Architecture</h4>
          <p className="text-sm text-friction-text">{plan.architecture}</p>
        </section>

        <section className="space-y-2">
          <h4 className="panel-label">Delivery phases</h4>
          <ol className="space-y-2">
            {plan.phases.map((phase) => (
              <li key={phase.name} className="rounded-xl border border-friction-border bg-friction-surfaceAlt p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-friction-text">{phase.name}</p>
                  <span className="text-xs text-friction-muted">{phase.duration}</span>
                </div>
                <ul className="mt-2 space-y-1 text-sm text-friction-text">
                  {phase.tasks.map((task) => (
                    <li key={task} className="flex gap-2">
                      <span aria-hidden="true">•</span>
                      <span className="min-w-0 break-words">{task}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
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
              Warnings
            </p>
            <ul className="mt-2 space-y-1 text-sm text-friction-text">
              {plan.warnings.map((item) => (
                <li key={item} className="break-words">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </section>

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
