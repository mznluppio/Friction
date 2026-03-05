import { Check, ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Divergence,
  FrictionInboxDraft,
  FrictionResolutionChoice,
  PhaseAgentResponse,
  Phase1Result,
} from "@/lib/types";

const MIN_RATIONALE_LENGTH = 12;

function frictionKey(divergence: Divergence, index: number): string {
  return `${divergence.field}:${index}`;
}

function summarizeList(items?: string[]): string {
  if (!items?.length) return "";
  return items.slice(0, 3).join(", ");
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

function normalizeRationale(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function severityLabel(severity: Divergence["severity"]): string {
  if (severity === "high") return "High";
  if (severity === "medium") return "Medium";
  return "Low";
}

interface FrictionInboxCardProps {
  phase1: Phase1Result;
  agents: PhaseAgentResponse[];
  draft: FrictionInboxDraft;
  submitting?: boolean;
  onDirectionChange: (direction?: FrictionResolutionChoice) => void;
  onResolutionChange: (
    key: string,
    patch: Partial<{ choice: FrictionResolutionChoice; rationale: string }>,
  ) => void;
  onSubmit: (draftOverride?: FrictionInboxDraft) => void;
}

export function FrictionInboxCard({
  phase1,
  agents,
  draft,
  submitting = false,
  onDirectionChange,
  onResolutionChange,
  onSubmit,
}: FrictionInboxCardProps) {
  const divergences = phase1.divergences ?? [];
  const [localDirection, setLocalDirection] = useState<FrictionResolutionChoice | undefined>(
    draft.direction,
  );
  const [localResolutions, setLocalResolutions] = useState<
    Record<string, { choice?: FrictionResolutionChoice; rationale: string }>
  >({});
  const [openByKey, setOpenByKey] = useState<Record<string, boolean>>({});
  const [advancedOpenByKey, setAdvancedOpenByKey] = useState<
    Record<string, boolean>
  >({});
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);
  const prevResolvedRef = useRef<Record<string, boolean>>({});

  useEffect(() => {
    const nextDirection = draft.direction;
    setLocalDirection((previous) =>
      previous === nextDirection ? previous : nextDirection,
    );

    setLocalResolutions((previous) => {
      const next: Record<string, { choice?: FrictionResolutionChoice; rationale: string }> = {};
      divergences.forEach((divergence, index) => {
        const key = frictionKey(divergence, index);
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
  }, [draft.direction, draft.resolutions, divergences]);

  const rows = useMemo(
    () =>
      divergences.map((divergence, index) => {
        const key = frictionKey(divergence, index);
        const existing = draft.resolutions.find((entry) => entry.key === key);
        const local = localResolutions[key];
        const choice = local?.choice ?? existing?.choice;
        const rationale = local?.rationale ?? existing?.rationale ?? "";
        const validRationale =
          normalizeRationale(rationale).length >= MIN_RATIONALE_LENGTH;
        return {
          divergence,
          index,
          key,
          field: divergence.field,
          severity: divergence.severity,
          choice,
          rationale,
          validRationale,
          resolved: Boolean(choice) && validRationale,
        };
      }),
    [divergences, draft.resolutions, localResolutions],
  );

  const invalidKeys = useMemo(
    () => rows.filter((row) => !row.resolved).map((row) => row.key),
    [rows],
  );
  const canRun = rows.length === 0 || invalidKeys.length === 0;
  const resolvedCount = rows.filter((row) => row.resolved).length;
  const totalCount = rows.length;

  useEffect(() => {
    setOpenByKey((previous) => {
      const next = { ...previous };
      let changed = false;
      rows.forEach((row) => {
        const hasValue = Object.prototype.hasOwnProperty.call(next, row.key);
        const prevResolved = prevResolvedRef.current[row.key];
        if (!hasValue) {
          const target = !row.resolved;
          next[row.key] = target;
          changed = true;
          return;
        }
        if (prevResolved !== row.resolved) {
          const target = !row.resolved;
          if (next[row.key] !== target) {
            next[row.key] = target;
            changed = true;
          }
        }
      });
      Object.keys(next).forEach((key) => {
        if (!rows.some((row) => row.key === key)) {
          delete next[key];
          changed = true;
        }
      });
      return changed ? next : previous;
    });

    setAdvancedOpenByKey((previous) => {
      const next = { ...previous };
      let changed = false;
      Object.keys(next).forEach((key) => {
        if (!rows.some((row) => row.key === key)) {
          delete next[key];
          changed = true;
        }
      });
      return changed ? next : previous;
    });

    const nextResolved: Record<string, boolean> = {};
    rows.forEach((row) => {
      nextResolved[row.key] = row.resolved;
    });
    prevResolvedRef.current = nextResolved;
  }, [rows]);

  useEffect(() => {
    if (!attemptedSubmit || invalidKeys.length === 0) return;
    const firstInvalidKey = invalidKeys[0];
    setOpenByKey((previous) => {
      if (previous[firstInvalidKey]) {
        return previous;
      }
      return {
        ...previous,
        [firstInvalidKey]: true,
      };
    });
  }, [attemptedSubmit, invalidKeys]);

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
          <p className="friction-inbox-title">Phase 1 — Resolve friction points</p>
          <p className="friction-inbox-subtitle">
            {resolvedCount}/{totalCount} resolved
          </p>
        </div>
        <span className={`friction-inbox-progress ${canRun ? "is-ready" : ""}`}>
          {canRun ? "Ready" : "Action required"}
        </span>
      </header>

      <div className="friction-inbox-direction">
        <p className="friction-inbox-direction-label">Direction override (optional)</p>
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
              }}
              aria-pressed={localDirection === option.value}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="friction-inbox-empty">
          No friction detected. You can run Phase 2 directly.
        </p>
      ) : (
        <div className="friction-inbox-list">
          {rows.map((row) => {
            const isOpen = openByKey[row.key] ?? !row.resolved;
            const invalid = attemptedSubmit && !row.resolved;
            const isAdvancedOpen = advancedOpenByKey[row.key] ?? false;
            return (
              <section
                key={row.key}
                className={["friction-row", invalid ? "is-invalid" : ""].join(" ")}
              >
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
                      {row.index + 1}. {row.field}
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
                                rationale:
                                  previous[row.key]?.rationale ?? row.rationale,
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

                    <label className="friction-rationale">
                      <span>Rationale</span>
                      <textarea
                        value={row.rationale}
                        rows={2}
                        onChange={(event) => {
                          const rationale = event.target.value;
                          setLocalResolutions((previous) => ({
                            ...previous,
                            [row.key]: {
                              choice: previous[row.key]?.choice ?? row.choice,
                              rationale,
                            },
                          }));
                          onResolutionChange(row.key, { rationale });
                        }}
                        placeholder="Why this choice is best for delivery and risk..."
                        aria-invalid={invalid}
                      />
                      <span className={row.validRationale ? "is-valid" : ""}>
                        {normalizeRationale(row.rationale).length}/{MIN_RATIONALE_LENGTH} min chars
                      </span>
                    </label>

                    <section className="friction-advanced-drawer">
                      <button
                        type="button"
                        className="friction-advanced-toggle"
                        onClick={() =>
                          setAdvancedOpenByKey((previous) => ({
                            ...previous,
                            [row.key]: !isAdvancedOpen,
                          }))
                        }
                        aria-expanded={isAdvancedOpen}
                      >
                        Advanced evidence
                      </button>
                      {isAdvancedOpen ? (
                        <>
                          <div className="friction-advanced-grid">
                            {agents.map((agent, agentIndex) => (
                              <section key={agent.id}>
                                <p>{agent.label}</p>
                                <p>{pickAgentSnippet(row.divergence, agent, agentIndex)}</p>
                              </section>
                            ))}
                          </div>
                          <pre>{JSON.stringify(row.divergence, null, 2)}</pre>
                        </>
                      ) : null}
                    </section>
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      )}

      <footer className="friction-inbox-footer">
        {!canRun ? (
          <p className="friction-inbox-hint">
            Resolve every friction with a choice and rationale before running Phase 2.
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
              Resolve &amp; Run Phase 2
            </>
          )}
        </button>
      </footer>
    </section>
  );
}
