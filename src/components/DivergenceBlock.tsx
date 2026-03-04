import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import type { Divergence, DivergenceAgentValue } from "../lib/types";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

interface DivergenceBlockProps {
  title: string;
  divergences: Divergence[];
  leftLabel?: string;
  rightLabel?: string;
}

const fieldLabels: Record<string, string> = {
  interpretation: "Interpretation",
  assumptions: "Assumptions",
  risks: "Risks",
  questions: "Questions",
  approach: "Approach",
  stack: "Stack",
  architecture: "Architecture",
  tradeoffs: "Tradeoffs",
  warnings: "Warnings"
};

function severityWeight(severity: Divergence["severity"]): number {
  if (severity === "high") return 3;
  if (severity === "medium") return 2;
  return 1;
}

function toneFromSeverity(severity: Divergence["severity"]): "neutral" | "warning" {
  return severity === "high" ? "warning" : "neutral";
}

function sortedDivergences(divergences: Divergence[]): Divergence[] {
  return [...divergences].sort((left, right) => {
    const severityDelta = severityWeight(right.severity) - severityWeight(left.severity);
    if (severityDelta !== 0) return severityDelta;
    const scoreDelta = (right.disagreementScore ?? 0) - (left.disagreementScore ?? 0);
    if (Math.abs(scoreDelta) > 0.0001) return scoreDelta > 0 ? 1 : -1;
    return left.field.localeCompare(right.field);
  });
}

function formatScore(value: number | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "n/a";
  return `${Math.round(value * 100)}%`;
}

function firstLine(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 160) return trimmed;
  return `${trimmed.slice(0, 160)}…`;
}

function DivergenceValue({ value }: { value: DivergenceAgentValue }) {
  const [expanded, setExpanded] = useState(false);

  if (value.kind === "text") {
    const text = value.text?.trim() ?? "";
    if (!text) {
      return <p className="text-sm text-friction-muted">No value</p>;
    }
    return (
      <div className="grid gap-1">
        <p className="text-sm text-friction-text">{expanded ? text : firstLine(text)}</p>
        {text.length > 160 ? (
          <button
            type="button"
            className="w-fit text-xs font-semibold text-friction-muted underline-offset-2 hover:underline"
            onClick={() => setExpanded((state) => !state)}
          >
            {expanded ? "Collapse" : "Expand"}
          </button>
        ) : null}
      </div>
    );
  }

  const items = value.items ?? [];
  if (items.length === 0) {
    return <p className="text-sm text-friction-muted">No value</p>;
  }
  const preview = expanded ? items : items.slice(0, 3);
  return (
    <div className="grid gap-1">
      <ul className="space-y-1 text-sm text-friction-text">
        {preview.map((item, index) => (
          <li key={`${item}-${index}`} className="flex gap-2">
            <span aria-hidden="true">•</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
      {items.length > 3 ? (
        <button
          type="button"
          className="w-fit text-xs font-semibold text-friction-muted underline-offset-2 hover:underline"
          onClick={() => setExpanded((state) => !state)}
        >
          {expanded ? "Collapse" : `Show ${items.length - 3} more`}
        </button>
      ) : null}
    </div>
  );
}

function LegacyPairColumns({
  divergence,
  leftLabel,
  rightLabel
}: {
  divergence: Divergence;
  leftLabel: string;
  rightLabel: string;
}) {
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <section className="rounded-md border border-friction-border bg-friction-surface p-2.5">
        <p className="panel-label">{leftLabel}</p>
        {divergence.a ? <p className="text-sm text-friction-text">{divergence.a}</p> : null}
        {divergence.uniqueA?.length ? (
          <ul className="mt-2 space-y-1 text-sm text-friction-text">
            {divergence.uniqueA.map((item, index) => (
              <li key={`${item}-${index}`} className="flex gap-2">
                <span aria-hidden="true">•</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {!divergence.a && !divergence.uniqueA?.length ? (
          <p className="text-sm text-friction-muted">No distinct signal</p>
        ) : null}
      </section>

      <section className="rounded-md border border-friction-border bg-friction-surface p-2.5">
        <p className="panel-label">{rightLabel}</p>
        {divergence.b ? <p className="text-sm text-friction-text">{divergence.b}</p> : null}
        {divergence.uniqueB?.length ? (
          <ul className="mt-2 space-y-1 text-sm text-friction-text">
            {divergence.uniqueB.map((item, index) => (
              <li key={`${item}-${index}`} className="flex gap-2">
                <span aria-hidden="true">•</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {!divergence.b && !divergence.uniqueB?.length ? (
          <p className="text-sm text-friction-muted">No distinct signal</p>
        ) : null}
      </section>
    </div>
  );
}

export function DivergenceBlock({
  title,
  divergences,
  leftLabel = "Agent A",
  rightLabel = "Agent B"
}: DivergenceBlockProps) {
  const sorted = sortedDivergences(divergences);

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-friction-warningText" aria-hidden="true" />
          {title}
        </CardTitle>
        {divergences.length === 0 ? (
          <Badge tone="glow">Aligned</Badge>
        ) : (
          <Badge tone={divergences.length >= 3 ? "warning" : "neutral"}>
            {divergences.length} friction{divergences.length === 1 ? "" : "s"}
          </Badge>
        )}
      </CardHeader>

      <CardContent>
        {sorted.length === 0 ? (
          <p className="text-sm text-friction-successText">Strong convergence between agents.</p>
        ) : (
          <div className="space-y-3">
            {sorted.map((divergence, index) => {
              const values = divergence.agentValues ?? [];
              const isConsensusMode = values.length >= 2 && divergence.mode === "consensus";
              const outlierLabels = divergence.outlierAgentIds?.map((id) => {
                const match = values.find((value) => value.agentId === id);
                return match?.label ?? id;
              });

              return (
                <article key={`${divergence.field}-${index}`} className="rounded-lg border border-friction-border bg-friction-surfaceAlt p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <p className="panel-label">{fieldLabels[divergence.field] ?? divergence.field}</p>
                    <Badge tone={toneFromSeverity(divergence.severity)}>{divergence.severity}</Badge>
                    {typeof divergence.disagreementScore === "number" ? (
                      <Badge tone="neutral">score {formatScore(divergence.disagreementScore)}</Badge>
                    ) : null}
                  </div>

                  {isConsensusMode ? (
                    <div className="space-y-2">
                      {divergence.consensusText ? (
                        <section className="rounded-md border border-friction-border bg-friction-surface p-2.5">
                          <p className="panel-label">Consensus</p>
                          <p className="text-sm text-friction-text">{divergence.consensusText}</p>
                        </section>
                      ) : null}

                      {divergence.consensusItems?.length ? (
                        <section className="rounded-md border border-friction-border bg-friction-surface p-2.5">
                          <p className="panel-label">Consensus items</p>
                          <ul className="mt-1 space-y-1 text-sm text-friction-text">
                            {divergence.consensusItems.map((item, itemIndex) => (
                              <li key={`${item}-${itemIndex}`} className="flex gap-2">
                                <span aria-hidden="true">•</span>
                                <span>{item}</span>
                              </li>
                            ))}
                          </ul>
                        </section>
                      ) : null}

                      {outlierLabels && outlierLabels.length > 0 ? (
                        <section className="rounded-md border border-friction-border bg-friction-surface p-2.5">
                          <p className="panel-label">Outliers</p>
                          <div className="mt-1 flex flex-wrap gap-2">
                            {outlierLabels.map((label) => (
                              <Badge key={label} tone="warning">
                                {label}
                              </Badge>
                            ))}
                          </div>
                        </section>
                      ) : null}

                      <div className="grid gap-2">
                        {values.map((value) => (
                          <section key={value.agentId} className="rounded-md border border-friction-border bg-friction-surface p-2.5">
                            <div className="mb-1 flex items-center justify-between gap-2">
                              <p className="panel-label">{value.label}</p>
                              <Badge tone="neutral">distance {formatScore(value.distance)}</Badge>
                            </div>
                            <DivergenceValue value={value} />
                          </section>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <LegacyPairColumns
                      divergence={divergence}
                      leftLabel={leftLabel}
                      rightLabel={rightLabel}
                    />
                  )}
                </article>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
