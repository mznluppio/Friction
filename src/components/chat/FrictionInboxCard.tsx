import { Check, ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  Divergence,
  FrictionInboxDraft,
  FrictionResolutionChoice,
  PhaseAgentResponse,
  Phase1Result,
  TopDisagreement,
} from "@/lib/types";

function summarizeList(items?: string[]): string {
  if (!items?.length) return "";
  return items.slice(0, 3).join(", ");
}

function fieldLabel(field: string): string {
  const normalized = field.trim().toLowerCase();
  if (normalized === "interpretation") return "problem framing";
  if (normalized === "assumptions") return "scope assumptions";
  if (normalized === "risks") return "risk framing";
  if (normalized === "questions") return "open questions";
  if (normalized === "approach") return "investigation strategy";
  return field.replace(/_/g, " ");
}

function summarizeAgentValue(divergence: Divergence, agentId: string, label: string): string {
  const values = divergence.agentValues ?? [];
  const fromId = values.find((item) => item.agentId === agentId);
  const fromLabel = values.find((item) => item.label === label);
  const selected = fromId ?? fromLabel;
  const valueText = selected?.text?.trim() || summarizeList(selected?.items);
  if (valueText) return valueText;
  return "";
}

function toAgentChoice(agentId: string): FrictionResolutionChoice {
  return `agent:${agentId}`;
}

function pickAgentSnippet(
  divergence: Divergence,
  agent: PhaseAgentResponse,
  index: number,
): string {
  const fromAgentValues = summarizeAgentValue(divergence, agent.id, agent.label);
  if (fromAgentValues) return fromAgentValues;

  const primary = index === 0 ? divergence.a?.trim() : index === 1 ? divergence.b?.trim() : "";
  if (primary) return primary;

  const listFallback =
    index === 0
      ? summarizeList(divergence.uniqueA)
      : index === 1
        ? summarizeList(divergence.uniqueB)
        : "";
  if (listFallback) return listFallback;

  const consensus = divergence.consensusText?.trim() || summarizeList(divergence.consensusItems);
  if (consensus) return consensus;

  return "No distinct signal.";
}

function severityLabel(severity: Divergence["severity"]): string {
  if (severity === "high") return "High";
  if (severity === "medium") return "Medium";
  return "Low";
}

interface FrictionInboxCardProps {
  phase1: Phase1Result;
  topDisagreements: TopDisagreement[];
  agents: PhaseAgentResponse[];
  draft: FrictionInboxDraft;
  submitting?: boolean;
  onDirectionChange: (direction?: FrictionResolutionChoice) => void;
  onContextNoteChange: (value: string) => void;
  onResolutionChange: (
    key: string,
    patch: Partial<{ choice: FrictionResolutionChoice; rationale: string }>,
  ) => void;
  onSubmit: (draftOverride?: FrictionInboxDraft) => void;
}

export function FrictionInboxCard({
  phase1,
  topDisagreements,
  agents,
  draft,
  submitting = false,
  onDirectionChange,
  onContextNoteChange,
  onResolutionChange,
  onSubmit,
}: FrictionInboxCardProps) {
  const [localDirection, setLocalDirection] = useState<FrictionResolutionChoice | undefined>(
    draft.direction,
  );
  const [localContextNote, setLocalContextNote] = useState(draft.contextNote ?? "");
  const [localResolutions, setLocalResolutions] = useState<
    Record<string, { choice?: FrictionResolutionChoice; rationale: string }>
  >({});
  const [openByKey, setOpenByKey] = useState<Record<string, boolean>>({});
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);
  const hiddenCount = Math.max(phase1.divergences.length - topDisagreements.length, 0);

  useEffect(() => {
    const nextDirection = draft.direction;
    setLocalDirection((previous) =>
      previous === nextDirection ? previous : nextDirection,
    );
    const nextContextNote = draft.contextNote ?? "";
    setLocalContextNote((previous) =>
      previous === nextContextNote ? previous : nextContextNote,
    );

    setLocalResolutions((previous) => {
      const next: Record<string, { choice?: FrictionResolutionChoice; rationale: string }> = {};
      topDisagreements.forEach((item) => {
        const key = item.key;
        const existing = draft.resolutions.find((entry) => entry.key === key);
        next[key] = {
          choice: existing?.choice,
          rationale: existing?.rationale ?? "",
        };
      });

      const previousKeys = Object.keys(previous);
      const nextKeys = Object.keys(next);
      if (previousKeys.length !== nextKeys.length) {
        return next;
      }

      for (const key of nextKeys) {
        const prev = previous[key];
        const current = next[key];
        if (!prev) {
          return next;
        }
        if (
          prev.choice !== current.choice ||
          prev.rationale !== current.rationale
        ) {
          return next;
        }
      }

      return previous;
    });
  }, [draft.contextNote, draft.direction, draft.resolutions, topDisagreements]);

  const rows = useMemo(
    () =>
      topDisagreements.map((item) => {
        const divergence = item.divergence;
        const key = item.key;
        const existing = draft.resolutions.find((entry) => entry.key === key);
        const local = localResolutions[key];
        const choice = local?.choice ?? existing?.choice;
        const rationale = local?.rationale ?? existing?.rationale ?? "";
        return {
          divergence,
          index: item.index,
          rank: item.rank,
          key,
          field: fieldLabel(divergence.field),
          severity: divergence.severity,
          choice,
          rationale,
          resolved: Boolean(choice),
        };
      }),
    [draft.resolutions, localResolutions, topDisagreements],
  );

  const invalidKeys = useMemo(
    () => rows.filter((row) => !row.resolved).map((row) => row.key),
    [rows],
  );
  const canRun = rows.length === 0 || invalidKeys.length === 0;
  const resolvedCount = rows.filter((row) => row.resolved).length;
  const totalCount = rows.length;

  const directionOptions = useMemo(
    () => [
      ...agents.map((agent) => ({
        value: toAgentChoice(agent.id),
        label: agent.label,
      })),
      { value: "hybrid" as FrictionResolutionChoice, label: "Hybrid" },
    ],
    [agents],
  );

  const rowChoiceOptions = useMemo(
    () => [
      ...agents.map((agent) => ({
        value: toAgentChoice(agent.id),
        label: `Prefer ${agent.label}`,
      })),
      { value: "hybrid" as FrictionResolutionChoice, label: "Hybrid" },
    ],
    [agents],
  );

  return (
    <section className="friction-inbox-card">
      <header className="friction-inbox-header">
        <div>
          <p className="friction-inbox-title">Phase 1 — Choose the disagreement path</p>
          <p className="friction-inbox-subtitle">
            {resolvedCount}/{totalCount} strategic disagreements resolved
            {hiddenCount > 0 ? ` · ${hiddenCount} minor points hidden` : ""}
          </p>
        </div>
        <span className={`friction-inbox-progress ${canRun ? "is-ready" : ""}`}>
          {canRun ? "Ready" : "Action required"}
        </span>
      </header>

      <div className="friction-inbox-direction">
        <p className="friction-inbox-direction-label">Who do you side with? (optional override)</p>
        <p className="text-xs text-friction-muted">
          Apply a default direction for all friction points, then adjust exceptions below.
        </p>
        <div className="friction-inbox-direction-buttons" role="radiogroup" aria-label="Direction override">
          {directionOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={[
                "friction-choice-pill",
                localDirection === option.value ? "is-active" : "",
              ].join(" ")}
              onClick={() => {
                const nextDirection =
                  localDirection === option.value ? undefined : option.value;
                setLocalDirection(nextDirection);
                onDirectionChange(nextDirection);
                if (!nextDirection) return;
                const unresolvedRows = rows.filter((row) => !row.choice);
                if (unresolvedRows.length === 0) return;
                setLocalResolutions((previous) => {
                  const next = { ...previous };
                  unresolvedRows.forEach((row) => {
                    next[row.key] = {
                      choice: nextDirection,
                      rationale: previous[row.key]?.rationale ?? row.rationale,
                    };
                  });
                  return next;
                });
                unresolvedRows.forEach((row) => {
                  onResolutionChange(row.key, { choice: nextDirection });
                });
              }}
              aria-pressed={localDirection === option.value}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <label className="friction-rationale">
        <span>Strategic context (optional)</span>
        <textarea
          value={localContextNote}
          rows={3}
          onChange={(event) => {
            const value = event.target.value;
            setLocalContextNote(value);
            onContextNoteChange(value);
          }}
          placeholder="Clarify the vision, team constraints, or business logic. (e.g. 'Always prioritize scale over short-term speed.')"
        />
      </label>

      {rows.length === 0 ? (
        <p className="friction-inbox-empty">
          No high-priority disagreement detected. You can generate the brief directly.
        </p>
      ) : (
        <div className="friction-inbox-list mt-2">
          <button
            type="button"
            className="w-full text-left py-2 px-3 text-[13px] font-medium text-friction-text flex items-center justify-between border rounded-lg border-friction-border bg-friction-surface-alt transition-colors hover:bg-friction-surface"
            onClick={() => setShowAdvanced((prev) => !prev)}
          >
            <span>Advanced Adjustments ({rows.length} friction points)</span>
            <ChevronRight
              className={`h-4 w-4 text-friction-muted transition-transform ${showAdvanced ? "rotate-90" : ""}`}
            />
          </button>
          {showAdvanced ? (
            <div className="mt-3 grid gap-3 pl-2 border-l-2 border-friction-border ml-1">
              {rows.map((row) => {
                const isOpen = openByKey[row.key] ?? false;
                const invalid = attemptedSubmit && !row.resolved;
                return (
                  <section key={row.key} className={["friction-row", invalid ? "is-invalid" : ""].join(" ")}>
                    <button
                      type="button"
                      className="friction-row-summary w-full border-0 bg-transparent text-left"
                      onClick={() =>
                        setOpenByKey((previous) => ({
                          ...previous,
                          [row.key]: !isOpen,
                        }))
                      }
                      aria-expanded={isOpen}
                    >
                      <div className="friction-row-main">
                        <p className="friction-row-title">
                          {row.rank + 1}. {row.field}
                        </p>
                        <div className="friction-row-agent-snippets">
                          {agents.map((agent, agentIndex) => (
                            <p key={agent.id} className="friction-row-agent-line">
                              <span className="friction-row-agent-label">{agent.label}</span>
                              <span className="friction-row-agent-text">
                                {pickAgentSnippet(row.divergence, agent, agentIndex)}
                              </span>
                            </p>
                          ))}
                        </div>
                      </div>
                      <div className="friction-row-meta">
                        <span className={`friction-severity severity-${row.severity}`}>
                          {severityLabel(row.severity)}
                        </span>
                        <span className={`friction-row-status ${row.resolved ? "is-resolved" : ""}`}>
                          {row.resolved ? "Resolved" : "Unresolved"}
                        </span>
                        <ChevronRight
                          className={`friction-row-chevron h-4 w-4 ${isOpen ? "is-open" : ""}`}
                          aria-hidden="true"
                        />
                      </div>
                    </button>

                    {isOpen ? (
                      <div className="friction-row-content">
                        <div className="friction-choice-group" role="radiogroup" aria-label={`Choice for ${row.field}`}>
                          {rowChoiceOptions.map((choiceOption) => (
                            <button
                              key={choiceOption.value}
                              type="button"
                              className={[
                                "friction-choice-pill",
                                row.choice === choiceOption.value ? "is-active" : "",
                              ].join(" ")}
                              onClick={() => {
                                setLocalResolutions((previous) => ({
                                  ...previous,
                                  [row.key]: {
                                    choice: choiceOption.value,
                                    rationale: previous[row.key]?.rationale ?? row.rationale,
                                  },
                                }));
                                onResolutionChange(row.key, { choice: choiceOption.value });
                              }}
                              aria-pressed={row.choice === choiceOption.value}
                            >
                              {choiceOption.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>
          ) : null}
        </div>
      )}

      <footer className="friction-inbox-footer">
        {!canRun ? (
          <p className="friction-inbox-hint">
            Pick a side or hybrid for each top disagreement. Add context once if it matters.
          </p>
        ) : null}
        <button
          type="button"
          className="friction-inbox-submit"
          disabled={submitting || !canRun}
          onClick={() => {
            setAttemptedSubmit(true);
            if (!canRun) return;
            onSubmit({
              direction: localDirection,
              contextNote: localContextNote,
              status: canRun ? "ready" : "draft",
              resolutions: rows.map((row) => ({
                key: row.key,
                field: row.field,
                severity: row.severity,
                choice: row.choice,
                rationale: row.rationale,
              })),
            });
          }}
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Running…
            </>
          ) : (
            <>
              <Check className="h-4 w-4" aria-hidden="true" />
              Generate brief
            </>
          )}
        </button>
      </footer>
    </section>
  );
}
