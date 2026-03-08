import { ChevronRight, Download } from "lucide-react";
import type { ExecutionBrief } from "@/lib/types";
import { Phase3ValidateInline } from "./Phase3ValidateInline";

interface ExecutionBriefCardProps {
  brief: ExecutionBrief;
  canPersistSession: boolean;
  datasetLoading?: boolean;
  repoPath: string;
  baseBranch: string;
  proofModeOpen: boolean;
  consentedToDataset: boolean;
  phase3Loading?: boolean;
  phase3FormError?: string | null;
  onExportSession: () => void;
  onExportDataset: () => void;
  onNewThread: () => void;
  onProofModeOpenChange: (value: boolean) => void;
  onRepoPathChange: (value: string) => void;
  onBaseBranchChange: (value: string) => void;
  onDatasetOptInChange: (value: boolean) => void;
  onRunPhase3: () => void;
}

function fallbackItems(items: string[], fallback: string): string[] {
  return items.length > 0 ? items : [fallback];
}

export function ExecutionBriefCard({
  brief,
  canPersistSession,
  datasetLoading = false,
  repoPath,
  baseBranch,
  proofModeOpen,
  consentedToDataset,
  phase3Loading = false,
  phase3FormError = null,
  onExportSession,
  onExportDataset,
  onNewThread,
  onProofModeOpenChange,
  onRepoPathChange,
  onBaseBranchChange,
  onDatasetOptInChange,
  onRunPhase3,
}: ExecutionBriefCardProps) {
  const tradeoffs = fallbackItems(
    brief.acceptedTradeoffs,
    "No explicit tradeoff captured.",
  );
  const steps = fallbackItems(brief.nextSteps, "No next step captured.");
  const risks = fallbackItems(brief.openRisks, "No explicit open risk captured.");
  const questions = fallbackItems(
    brief.openQuestions,
    "No open question captured.",
  );

  return (
    <section className="workflow-inline-block">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="workflow-inline-title">Action brief</p>
          <p className="workflow-inline-subtitle">{brief.finalDecision}</p>
        </div>
        <span className="inline-flex min-h-7 items-center rounded-full border border-friction-border px-3 text-xs font-medium text-friction-muted">
          {brief.mode === "winner" ? "Keep one plan" : "Hybrid"}
        </span>
      </div>

      <div className="mt-4 grid gap-4">
        <section className="grid gap-1">
          <span className="panel-label">Problem frame</span>
          <p className="text-sm text-friction-text">{brief.problemFrame}</p>
        </section>

        <section className="grid gap-1">
          <span className="panel-label">Baseline approach</span>
          <p className="text-sm text-friction-text">{brief.baselineApproach}</p>
        </section>

        <section className="grid gap-1">
          <span className="panel-label">Main hypothesis</span>
          <p className="text-sm text-friction-text">{brief.mainHypothesis}</p>
        </section>

        <section className="grid gap-1">
          <span className="panel-label">Accepted tradeoffs</span>
          <ul className="grid list-disc gap-2 pl-5 text-sm text-friction-text">
            {tradeoffs.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        <section className="grid gap-1">
          <span className="panel-label">Constraints and context</span>
          <p className="text-sm text-friction-text">{brief.constraints}</p>
        </section>

        <section className="grid gap-1">
          <span className="panel-label">Next steps</span>
          <ol className="grid list-decimal gap-2 pl-5 text-sm text-friction-text">
            {steps.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
        </section>

        <section className="grid gap-1">
          <span className="panel-label">Open risks</span>
          <ul className="grid list-disc gap-2 pl-5 text-sm text-friction-text">
            {risks.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        <section className="grid gap-1">
          <span className="panel-label">Open questions</span>
          <ul className="grid list-disc gap-2 pl-5 text-sm text-friction-text">
            {questions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        {brief.mergeNote ? (
          <section className="grid gap-1">
            <span className="panel-label">Merge note</span>
            <p className="text-sm text-friction-text">{brief.mergeNote}</p>
          </section>
        ) : null}
      </div>

      <div className="workflow-inline-actions mt-4">
        <button
          type="button"
          className="workflow-inline-secondary"
          onClick={onExportSession}
          disabled={!canPersistSession}
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          Export session
        </button>
        <button
          type="button"
          className="workflow-inline-secondary"
          onClick={onExportDataset}
          disabled={datasetLoading}
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          {datasetLoading ? "Exporting dataset..." : "Export dataset"}
        </button>
        <button
          type="button"
          className="workflow-inline-primary"
          onClick={onNewThread}
        >
          New thread
        </button>
      </div>

      <div className="mt-4 grid gap-3">
        <button
          type="button"
          className="workflow-inline-secondary justify-between"
          onClick={() => onProofModeOpenChange(!proofModeOpen)}
          aria-expanded={proofModeOpen}
        >
          <span>{proofModeOpen ? "Hide proof mode" : "Open proof mode"}</span>
          <ChevronRight
            className={`friction-inline-chevron ${proofModeOpen ? "is-open" : ""}`}
            aria-hidden="true"
          />
        </button>

        {proofModeOpen ? (
          <Phase3ValidateInline
            repoPath={repoPath}
            baseBranch={baseBranch}
            consentedToDataset={consentedToDataset}
            running={phase3Loading}
            error={phase3FormError}
            onRepoPathChange={onRepoPathChange}
            onBaseBranchChange={onBaseBranchChange}
            onDatasetOptInChange={onDatasetOptInChange}
            onRun={onRunPhase3}
          />
        ) : null}
      </div>
    </section>
  );
}
