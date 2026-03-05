import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  Divergence,
  FrictionInboxDraft,
  FrictionResolutionChoice,
  Phase1Result,
  PhaseAgentResponse,
} from "@/lib/types";
import { FrictionInboxCard } from "./FrictionInboxCard";

interface FrictionPhase1InlineProps {
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

export function FrictionPhase1Inline({
  phase1,
  agents,
  draft,
  submitting = false,
  onDirectionChange,
  onResolutionChange,
  onSubmit,
}: FrictionPhase1InlineProps) {
  const [isInterpretationOpen, setIsInterpretationOpen] = useState(false);

  const interpretationRows = useMemo(
    () =>
      phase1.divergences.map((divergence, index) => ({
        key: `${divergence.field}:${index}`,
        title: `${index + 1}. ${divergence.field}`,
        snippets: agents.map((agent, agentIndex) => ({
          agentId: agent.id,
          label: agent.label,
          text: pickAgentSnippet(divergence, agent, agentIndex),
        })),
      })),
    [agents, phase1.divergences],
  );

  return (
    <section className="friction-inline-root">
      <button
        type="button"
        className="friction-inline-interpretation-summary"
        onClick={() => setIsInterpretationOpen((value) => !value)}
        aria-expanded={isInterpretationOpen}
      >
        <div>
          <p className="friction-inline-interpretation-title">
            Phase 1 — Multi-agent interpretation
          </p>
          <p className="friction-inline-interpretation-subtitle">
            {phase1.divergences.length} friction point
            {phase1.divergences.length !== 1 ? "s" : ""} · {agents.length} agent
            {agents.length > 1 ? "s" : ""}
          </p>
        </div>
        <ChevronRight
          className={`friction-inline-chevron ${isInterpretationOpen ? "is-open" : ""}`}
          aria-hidden="true"
        />
      </button>

      {isInterpretationOpen ? (
        <div className="friction-inline-interpretation-body">
          {interpretationRows.length === 0 ? (
            <p className="friction-inline-empty">No divergences detected.</p>
          ) : (
            <ul className="friction-inline-interpretation-list">
              {interpretationRows.map((row) => (
                <li key={row.key}>
                  <p className="friction-inline-interpretation-row-title">{row.title}</p>
                  <div className="friction-inline-agent-snippets">
                    {row.snippets.map((snippet) => (
                      <p key={snippet.agentId} className="friction-inline-agent-line">
                        <span className="friction-inline-agent-label">{snippet.label}</span>
                        <span className="friction-inline-agent-text">{snippet.text}</span>
                      </p>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <div className="friction-inline-divider" />

      <FrictionInboxCard
        phase1={phase1}
        agents={agents}
        draft={draft}
        submitting={submitting}
        onDirectionChange={onDirectionChange}
        onResolutionChange={onResolutionChange}
        onSubmit={onSubmit}
      />
    </section>
  );
}
