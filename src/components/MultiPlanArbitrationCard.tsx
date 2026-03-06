import { useEffect, useMemo, useState } from "react";
import type {
  ArbitrationCriterion,
  HumanDecisionStructured,
  PhaseAgentPlan,
  PlanScorecardRow,
} from "../lib/types";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

const CRITERIA: ArbitrationCriterion[] = [
  "robustness",
  "deliverySpeed",
  "implementationCost",
  "operationalComplexity",
];

interface MultiPlanArbitrationCardProps {
  plans: PhaseAgentPlan[];
  disabled?: boolean;
  onInsertDecision: (note: string, structured: HumanDecisionStructured) => void;
}

function firstLine(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "No summary provided.";
  const dotIndex = trimmed.indexOf(". ");
  if (dotIndex > 0 && dotIndex < 180) {
    return trimmed.slice(0, dotIndex + 1);
  }
  return trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
}

function buildNeutralScorecard(plans: PhaseAgentPlan[]): PlanScorecardRow[] {
  return plans.map((plan) => ({
    agentId: plan.id,
    label: plan.label,
    scores: {
      robustness: 3,
      deliverySpeed: 3,
      implementationCost: 3,
      operationalComplexity: 3,
    },
    total: CRITERIA.length * 3,
  }));
}

export function MultiPlanArbitrationCard({
  plans,
  disabled,
  onInsertDecision,
}: MultiPlanArbitrationCardProps) {
  const [mode, setMode] = useState<"winner" | "hybrid">("winner");
  const [winnerAgentId, setWinnerAgentId] = useState<string>(plans[0]?.id ?? "");
  const [baseAgentId, setBaseAgentId] = useState<string>(plans[0]?.id ?? "");
  const [rationale, setRationale] = useState("");

  useEffect(() => {
    if (!plans.find((plan) => plan.id === winnerAgentId)) {
      setWinnerAgentId(plans[0]?.id ?? "");
    }
    if (!plans.find((plan) => plan.id === baseAgentId)) {
      setBaseAgentId(plans[0]?.id ?? "");
    }
  }, [baseAgentId, plans, winnerAgentId]);

  const scorecard = useMemo(() => buildNeutralScorecard(plans), [plans]);

  function createDecisionNote(): {
    note: string;
    structured: HumanDecisionStructured;
  } {
    const winnerPlan =
      plans.find((plan) => plan.id === winnerAgentId) ?? plans[0] ?? null;
    const basePlan =
      plans.find((plan) => plan.id === baseAgentId) ?? plans[0] ?? null;

    const rationaleLine =
      rationale.trim() ||
      (mode === "winner"
        ? "Keep the clearest plan and accept its explicit tradeoffs."
        : "Keep one base plan and merge only the strongest ideas from the others.");

    if (mode === "winner" && winnerPlan) {
      const note = [
        "Decision mode: winner",
        `Winner: ${winnerPlan.label}`,
        `Why now: ${rationaleLine}`,
        "",
        "Accepted tradeoffs:",
        ...(winnerPlan.plan.tradeoffs.slice(0, 2).length > 0
          ? winnerPlan.plan.tradeoffs.slice(0, 2).map((item) => `- ${item}`)
          : ["- No explicit tradeoff captured."]),
      ].join("\n");

      return {
        note,
        structured: {
          mode: "winner",
          winnerAgentId: winnerPlan.id,
          scorecard,
          rationale: rationaleLine,
        },
      };
    }

    const mergedPlans = plans.filter((plan) => plan.id !== basePlan?.id);
    const note = [
      "Decision mode: hybrid",
      `Base plan: ${basePlan?.label ?? "Unknown base plan"}`,
      `Why now: ${rationaleLine}`,
      "",
      "Merge rule:",
      `- Keep ${basePlan?.label ?? "the base plan"} as the implementation baseline.`,
      ...(mergedPlans.length > 0
        ? mergedPlans
            .slice(0, 2)
            .map((plan) => `- Borrow the strongest safeguard or shortcut from ${plan.label}.`)
        : ["- No secondary plan available."]),
    ].join("\n");

    return {
      note,
      structured: {
        mode: "hybrid",
        hybrid: {
          baseAgentId: basePlan?.id ?? "",
        },
        scorecard,
        rationale: rationaleLine,
      },
    };
  }

  if (plans.length < 2) {
    return null;
  }

  return (
    <Card className="mt-3">
      <CardHeader className="flex items-center justify-between gap-2">
        <CardTitle>Arbitration</CardTitle>
        <Badge tone="neutral">{plans.length} plans</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3">
          {plans.map((plan) => (
            <article
              key={plan.id}
              className="rounded-lg border border-friction-border bg-friction-surfaceAlt p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-friction-text">
                  {plan.label}
                </p>
                <div className="flex items-center gap-2 text-xs text-friction-muted">
                  <Badge tone="neutral">{plan.plan.stack.length} techs</Badge>
                  <Badge tone="neutral">{plan.plan.phases.length} phases</Badge>
                </div>
              </div>
              <p className="mt-2 text-sm text-friction-muted">
                {firstLine(plan.plan.architecture)}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn btn-ghost min-h-9 px-3 text-xs"
                  disabled={disabled}
                  onClick={() => {
                    setMode("winner");
                    setWinnerAgentId(plan.id);
                  }}
                >
                  Keep this plan
                </button>
                <button
                  type="button"
                  className="btn btn-ghost min-h-9 px-3 text-xs"
                  disabled={disabled}
                  onClick={() => {
                    setMode("hybrid");
                    setBaseAgentId(plan.id);
                  }}
                >
                  Use as merge base
                </button>
              </div>
            </article>
          ))}
        </div>

        <section className="rounded-lg border border-friction-border bg-friction-surfaceAlt p-3">
          <p className="panel-label">Decision mode</p>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="decision_mode"
                checked={mode === "winner"}
                disabled={disabled}
                onChange={() => setMode("winner")}
              />
              Keep one plan
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="decision_mode"
                checked={mode === "hybrid"}
                disabled={disabled}
                onChange={() => setMode("hybrid")}
              />
              Merge lightly
            </label>
          </div>

          {mode === "winner" ? (
            <label className="mt-3 grid gap-1">
              <span className="panel-label">Plan to keep</span>
              <select
                className="select-base"
                value={winnerAgentId}
                disabled={disabled}
                onChange={(event) => setWinnerAgentId(event.target.value)}
              >
                {plans.map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="mt-3 grid gap-1">
              <span className="panel-label">Base plan</span>
              <select
                className="select-base"
                value={baseAgentId}
                disabled={disabled}
                onChange={(event) => setBaseAgentId(event.target.value)}
              >
                {plans.map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="mt-3 grid gap-1">
            <span className="panel-label">Why now? (optional)</span>
            <textarea
              className="clarification-helper-textarea"
              rows={3}
              value={rationale}
              disabled={disabled}
              onChange={(event) => setRationale(event.target.value)}
              placeholder="One sentence on what matters most: speed, risk, reversibility, cost..."
            />
          </label>
        </section>

        <button
          type="button"
          className="btn btn-ghost min-h-10 w-full"
          disabled={disabled}
          onClick={() => {
            const payload = createDecisionNote();
            onInsertDecision(payload.note, payload.structured);
          }}
        >
          Apply decision
        </button>
      </CardContent>
    </Card>
  );
}
