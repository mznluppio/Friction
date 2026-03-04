import { useEffect, useMemo, useState } from "react";
import type {
  ArbitrationCriterion,
  HumanDecisionStructured,
  HybridSelection,
  PhaseAgentPlan,
  PlanScorecardRow
} from "../lib/types";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

const CRITERIA: { key: ArbitrationCriterion; label: string }[] = [
  { key: "robustness", label: "Robustness" },
  { key: "deliverySpeed", label: "Delivery speed" },
  { key: "implementationCost", label: "Implementation cost" },
  { key: "operationalComplexity", label: "Operational complexity" }
];

const HYBRID_SECTIONS: { key: keyof Omit<HybridSelection, "baseAgentId">; label: string }[] = [
  { key: "stack", label: "Stack" },
  { key: "architecture", label: "Architecture" },
  { key: "phases", label: "Phases" },
  { key: "warnings", label: "Warnings" }
];

interface MultiPlanArbitrationCardProps {
  plans: PhaseAgentPlan[];
  disabled?: boolean;
  onInsertDecision: (note: string, structured: HumanDecisionStructured) => void;
}

function defaultScoreMap(plans: PhaseAgentPlan[]): Record<string, Record<ArbitrationCriterion, number>> {
  const rows: Record<string, Record<ArbitrationCriterion, number>> = {};
  plans.forEach((plan) => {
    rows[plan.id] = {
      robustness: 3,
      deliverySpeed: 3,
      implementationCost: 3,
      operationalComplexity: 3
    };
  });
  return rows;
}

export function MultiPlanArbitrationCard({ plans, disabled, onInsertDecision }: MultiPlanArbitrationCardProps) {
  const [mode, setMode] = useState<"winner" | "hybrid">("winner");
  const [scores, setScores] = useState<Record<string, Record<ArbitrationCriterion, number>>>(() =>
    defaultScoreMap(plans)
  );
  const [winnerAgentId, setWinnerAgentId] = useState<string>(plans[0]?.id ?? "");
  const [baseAgentId, setBaseAgentId] = useState<string>(plans[0]?.id ?? "");
  const [hybridSources, setHybridSources] = useState<Record<string, string>>(() =>
    HYBRID_SECTIONS.reduce<Record<string, string>>((acc, item) => {
      acc[item.key] = plans[0]?.id ?? "";
      return acc;
    }, {})
  );
  const [rationale, setRationale] = useState("");

  useEffect(() => {
    setScores((previous) => {
      const next = defaultScoreMap(plans);
      plans.forEach((plan) => {
        if (!previous[plan.id]) return;
        next[plan.id] = { ...next[plan.id], ...previous[plan.id] };
      });
      return next;
    });

    if (!plans.find((plan) => plan.id === winnerAgentId)) {
      setWinnerAgentId(plans[0]?.id ?? "");
    }
    if (!plans.find((plan) => plan.id === baseAgentId)) {
      setBaseAgentId(plans[0]?.id ?? "");
    }
    setHybridSources((previous) => {
      const fallback = plans[0]?.id ?? "";
      const next: Record<string, string> = {};
      HYBRID_SECTIONS.forEach((section) => {
        const current = previous[section.key];
        next[section.key] = plans.find((plan) => plan.id === current)?.id ?? fallback;
      });
      return next;
    });
  }, [plans, winnerAgentId, baseAgentId]);

  const rows = useMemo<PlanScorecardRow[]>(
    () =>
      plans.map((plan) => {
        const rowScores = scores[plan.id] ?? {
          robustness: 3,
          deliverySpeed: 3,
          implementationCost: 3,
          operationalComplexity: 3
        };
        const total = CRITERIA.reduce((sum, criterion) => sum + rowScores[criterion.key], 0);
        return {
          agentId: plan.id,
          label: plan.label,
          scores: rowScores,
          total
        };
      }),
    [plans, scores]
  );

  const ranking = useMemo(
    () => [...rows].sort((left, right) => right.total - left.total || left.label.localeCompare(right.label)),
    [rows]
  );

  const topRank = ranking[0];

  useEffect(() => {
    if (!topRank) return;
    if (!winnerAgentId) {
      setWinnerAgentId(topRank.agentId);
    }
  }, [topRank, winnerAgentId]);

  function updateScore(agentId: string, criterion: ArbitrationCriterion, value: number) {
    setScores((previous) => ({
      ...previous,
      [agentId]: {
        ...(previous[agentId] ?? {
          robustness: 3,
          deliverySpeed: 3,
          implementationCost: 3,
          operationalComplexity: 3
        }),
        [criterion]: value
      }
    }));
  }

  function createDecisionNote(): { note: string; structured: HumanDecisionStructured } {
    const winnerLabel = plans.find((plan) => plan.id === winnerAgentId)?.label ?? winnerAgentId;
    const baseLabel = plans.find((plan) => plan.id === baseAgentId)?.label ?? baseAgentId;
    const rankingLines = ranking
      .map((row) => {
        const detail = CRITERIA.map((criterion) => `${criterion.label}=${row.scores[criterion.key]}`).join(", ");
        return `- ${row.label}: ${row.total}/20 (${detail})`;
      })
      .join("\n");

    const rationaleLine =
      rationale.trim() ||
      (mode === "winner"
        ? `Winner selected for best balanced score and acceptable tradeoffs.`
        : `Hybrid selected to combine high-scoring sections while keeping a stable base plan.`);

    if (mode === "winner") {
      const note = [
        "Decision mode: winner",
        `Winner: ${winnerLabel}`,
        "",
        "Scorecard:",
        rankingLines,
        "",
        `Rationale: ${rationaleLine}`
      ].join("\n");

      return {
        note,
        structured: {
          mode: "winner",
          winnerAgentId,
          scorecard: rows,
          rationale: rationaleLine
        }
      };
    }

    const hybridRows = HYBRID_SECTIONS.map((section) => {
      const sourceId = hybridSources[section.key] ?? baseAgentId;
      const sourceLabel = plans.find((plan) => plan.id === sourceId)?.label ?? sourceId;
      return `- ${section.label}: ${sourceLabel}`;
    }).join("\n");

    const note = [
      "Decision mode: hybrid",
      `Base plan: ${baseLabel}`,
      "",
      "Merge sources:",
      hybridRows,
      "",
      "Scorecard:",
      rankingLines,
      "",
      `Rationale: ${rationaleLine}`
    ].join("\n");

    return {
      note,
      structured: {
        mode: "hybrid",
        hybrid: {
          baseAgentId,
          stack: hybridSources.stack,
          architecture: hybridSources.architecture,
          phases: hybridSources.phases,
          warnings: hybridSources.warnings
        },
        scorecard: rows,
        rationale: rationaleLine
      }
    };
  }

  if (plans.length < 2) {
    return null;
  }

  return (
    <Card className="mt-3">
      <CardHeader className="flex items-center justify-between gap-2">
        <CardTitle>Multi-plan arbitration</CardTitle>
        <Badge tone="neutral">{plans.length} plans</Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3">
          {rows.map((row) => (
            <article key={row.agentId} className="rounded-lg border border-friction-border bg-friction-surfaceAlt p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-friction-text">{row.label}</p>
                <Badge tone="neutral">Total {row.total}/20</Badge>
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                {CRITERIA.map((criterion) => (
                  <label key={`${row.agentId}-${criterion.key}`} className="grid gap-1">
                    <span className="text-[11px] font-semibold text-friction-muted">{criterion.label}</span>
                    <select
                      className="select-base min-h-9"
                      value={row.scores[criterion.key]}
                      disabled={disabled}
                      onChange={(event) => updateScore(row.agentId, criterion.key, Number(event.target.value))}
                    >
                      <option value={1}>1</option>
                      <option value={2}>2</option>
                      <option value={3}>3</option>
                      <option value={4}>4</option>
                      <option value={5}>5</option>
                    </select>
                  </label>
                ))}
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
              Winner
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="decision_mode"
                checked={mode === "hybrid"}
                disabled={disabled}
                onChange={() => setMode("hybrid")}
              />
              Hybrid
            </label>
          </div>

          {mode === "winner" ? (
            <label className="mt-3 grid gap-1">
              <span className="panel-label">Winner plan</span>
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
            <div className="mt-3 grid gap-2">
              <label className="grid gap-1">
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

              {HYBRID_SECTIONS.map((section) => (
                <label key={section.key} className="grid gap-1">
                  <span className="panel-label">{section.label} source</span>
                  <select
                    className="select-base"
                    value={hybridSources[section.key] ?? baseAgentId}
                    disabled={disabled}
                    onChange={(event) =>
                      setHybridSources((previous) => ({ ...previous, [section.key]: event.target.value }))
                    }
                  >
                    {plans.map((plan) => (
                      <option key={plan.id} value={plan.id}>
                        {plan.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          )}

          <label className="mt-3 grid gap-1">
            <span className="panel-label">Rationale (optional)</span>
            <textarea
              className="clarification-helper-textarea"
              rows={2}
              value={rationale}
              disabled={disabled}
              onChange={(event) => setRationale(event.target.value)}
              placeholder="Why this arbitration is the right tradeoff for now..."
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
          Insert decision note
        </button>
      </CardContent>
    </Card>
  );
}
