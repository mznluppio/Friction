import type { HumanDecisionStructured, PhaseAgentPlan } from "@/lib/types";
import { MultiPlanArbitrationCard } from "../MultiPlanArbitrationCard";

interface DecisionPhase2InlineProps {
  plans: PhaseAgentPlan[];
  disabled?: boolean;
  onApplyDecision: (note: string, structured: HumanDecisionStructured) => void;
}

export function DecisionPhase2Inline({
  plans,
  disabled = false,
  onApplyDecision,
}: DecisionPhase2InlineProps) {
  return (
    <section className="workflow-inline-block">
      <p className="workflow-inline-title">Phase 2 — Arbitration decision</p>
      <p className="workflow-inline-subtitle">
        Rate plans, choose winner/hybrid, then apply the decision inline.
      </p>
      <MultiPlanArbitrationCard
        plans={plans}
        disabled={disabled}
        onInsertDecision={onApplyDecision}
      />
    </section>
  );
}

