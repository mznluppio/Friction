import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  Divergence,
  FrictionInboxDraft,
  FrictionResolutionChoice,
  Phase1Result,
  PhaseAgentResponse,
  TopDisagreement,
} from "@/lib/types";
import { FrictionInboxCard } from "./FrictionInboxCard";

interface FrictionPhase1InlineProps {
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


function summarizeList(items?: string[]): string {
  if (!items?.length) return "";
  return items.slice(0, 3).join(", ") + (items.length > 3 ? "..." : "");
}

function fieldLabel(field: string): string {
  const normalized = field.trim().toLowerCase();
  if (normalized === "interpretation") return "Problem Framing Strategy";
  if (normalized === "assumptions") return "Boundary Assumptions";
  if (normalized === "risks") return "Risk Mitigation Framing";
  if (normalized === "questions") return "Critical Open Questions";
  if (normalized === "approach") return "Investigation Strategy";
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
  topDisagreements,
  agents,
  draft,
  submitting = false,
  onDirectionChange,
  onContextNoteChange,
  onResolutionChange,
  onSubmit,
}: FrictionPhase1InlineProps) {
  const [isInterpretationOpen, setIsInterpretationOpen] = useState(true);
  const hiddenCount = Math.max(phase1.divergences.length - topDisagreements.length, 0);

  const interpretationRows = useMemo(
    () =>
      topDisagreements.map((item) => ({
        key: item.key,
        title: `${item.rank + 1}. ${fieldLabel(item.field)}`,
        snippets: agents.map((agent, agentIndex) => ({
          agentId: agent.id,
          label: agent.label,
          text: pickAgentSnippet(item.divergence, agent, agentIndex),
        })),
      })),
    [agents, topDisagreements],
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
            {topDisagreements.length} top disagreement
            {topDisagreements.length !== 1 ? "s" : ""} shown
            {hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ""}
            {" · "}
            {agents.length} agent
            {agents.length > 1 ? "s" : ""}
          </p>
        </div>
        <ChevronRight
          className={`friction-inline-chevron ${isInterpretationOpen ? "is-open" : ""}`}
          aria-hidden="true"
        />
      </button>

      {isInterpretationOpen ? (
        <div className="friction-inline-interpretation-body p-4 pt-1">
          <p className="text-[13px] text-friction-muted mb-5 pb-3 border-b border-friction-border">
            The agents have analyzed the problem and identified {topDisagreements.length} key areas of divergence.
          </p>
          <div className="grid gap-6">
            {interpretationRows.map((row) => (
              <div key={row.key} className="flex flex-col gap-3">
                <h4 className="text-[14px] font-semibold text-friction-text">{row.title}</h4>
                <div className="flex flex-col gap-4 pl-4 border-l-2 border-friction-border ml-1">
                  {row.snippets.map((snippet) => (
                    <div key={snippet.agentId} className="flex flex-col">
                      <span className="text-[11px] font-semibold text-friction-muted uppercase tracking-wider mb-1">
                        {snippet.label}
                      </span>
                      <p className="text-[13px] text-friction-text leading-relaxed">
                        {snippet.text}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="friction-inline-divider" />

      <FrictionInboxCard
        phase1={phase1}
        topDisagreements={topDisagreements}
        agents={agents}
        draft={draft}
        submitting={submitting}
        onDirectionChange={onDirectionChange}
        onContextNoteChange={onContextNoteChange}
        onResolutionChange={onResolutionChange}
        onSubmit={onSubmit}
      />
    </section>
  );
}
