import { Check, ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";

export interface ClarificationDirectionOption {
  value: string;
  label: string;
  description: string;
}

interface ClarificationHelperProps {
  direction: string;
  directionOptions: ClarificationDirectionOption[];
  constraints: string;
  answers: string;
  questions: string[];
  disabled?: boolean;
  onDirectionChange: (value: string) => void;
  onConstraintsChange: (value: string) => void;
  onAnswersChange: (value: string) => void;
  onInsertTemplate: () => void;
}

function previewText(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (trimmed.length <= 90) return trimmed;
  return `${trimmed.slice(0, 90)}…`;
}

export function ClarificationHelper({
  direction,
  directionOptions,
  constraints,
  answers,
  questions,
  disabled,
  onDirectionChange,
  onConstraintsChange,
  onAnswersChange,
  onInsertTemplate
}: ClarificationHelperProps) {
  const [openStep, setOpenStep] = useState<1 | 2 | 3>(1);
  const [showAllQuestions, setShowAllQuestions] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  const selectedDirection = useMemo(
    () => directionOptions.find((option) => option.value === direction),
    [direction, directionOptions]
  );

  const questionsPreview = showAllQuestions ? questions : questions.slice(0, 1);
  const step2Done = constraints.trim().length > 0;
  const step3Done = answers.trim().length > 0 || questions.length === 0;
  const completedSteps = (selectedDirection ? 1 : 0) + (step2Done ? 1 : 0) + (step3Done ? 1 : 0);

  return (
    <section className="clarification-helper" aria-label="Clarification helper">
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-friction-text">Clarification helper</p>
          <p className="mt-1 text-xs text-friction-muted">
            Wizard compact: {completedSteps}/3 done.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="btn btn-ghost min-h-9 px-3 text-xs font-semibold"
            onClick={() => setIsExpanded((value) => !value)}
            disabled={disabled}
            aria-expanded={isExpanded}
          >
            {isExpanded ? "Collapse" : "Expand"}
          </button>
          <button
            type="button"
            className="btn btn-ghost min-h-9 px-3 text-xs font-semibold"
            onClick={onInsertTemplate}
            disabled={disabled}
          >
            Insert template
          </button>
        </div>
      </header>

      {!isExpanded ? (
        <div className="clarification-helper-collapsed">
          <p className="text-xs text-friction-muted">
            Direction: {selectedDirection ? selectedDirection.label : "Hybrid"} · Constraints:{" "}
            {step2Done ? "set" : "missing"} · Answers: {step3Done ? "set" : "pending"}
          </p>
          {questions.length > 0 ? (
            <p className="mt-1 text-xs text-friction-muted">
              Open questions detected: {questions.length}. Expand helper to answer them.
            </p>
          ) : null}
        </div>
      ) : null}

      {isExpanded ? (
        <>
          <div className="clarification-wizard-progress" role="list" aria-label="Wizard progression">
            <span className={["clarification-wizard-chip", openStep === 1 ? "is-active" : "is-done"].join(" ")}>1/3</span>
            <span className={["clarification-wizard-chip", openStep === 2 ? "is-active" : step2Done ? "is-done" : ""].join(" ")}>2/3</span>
            <span className={["clarification-wizard-chip", openStep === 3 ? "is-active" : step3Done ? "is-done" : ""].join(" ")}>3/3</span>
          </div>

          <section className="clarification-step">
            <button
              type="button"
              disabled={disabled}
              className="clarification-step-toggle"
              onClick={() => setOpenStep(1)}
              aria-expanded={openStep === 1}
            >
              <span>1) Direction</span>
              <span className="inline-flex items-center gap-1 text-xs text-friction-muted">
                {selectedDirection ? selectedDirection.label : "Choose"}
                <ChevronDown className={["h-3.5 w-3.5 transition-transform", openStep === 1 ? "rotate-180" : ""].join(" ")} />
              </span>
            </button>

            {openStep === 1 ? (
              <div className="clarification-step-body">
                <div className="grid gap-2 md:grid-cols-3">
                  {directionOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        onDirectionChange(option.value);
                        setOpenStep(2);
                      }}
                      className={[
                        "btn btn-ghost min-h-11 justify-start px-3 text-left",
                        direction === option.value ? "is-active" : ""
                      ].join(" ")}
                    >
                      <span className="flex flex-col gap-0.5">
                        <span className="text-sm font-semibold">{option.label}</span>
                        <span className="text-xs text-friction-muted">{option.description}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </section>

          <section className="clarification-step">
            <button
              type="button"
              disabled={disabled}
              className="clarification-step-toggle"
              onClick={() => setOpenStep(2)}
              aria-expanded={openStep === 2}
            >
              <span>2) Hard constraints</span>
              <span className="inline-flex items-center gap-1 text-xs text-friction-muted">
                {step2Done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                {previewText(constraints, "Timeline, team, budget…")}
                <ChevronDown className={["h-3.5 w-3.5 transition-transform", openStep === 2 ? "rotate-180" : ""].join(" ")} />
              </span>
            </button>

            {openStep === 2 ? (
              <div className="clarification-step-body">
                <textarea
                  value={constraints}
                  disabled={disabled}
                  onChange={(event) => {
                    onConstraintsChange(event.target.value);
                    if (event.target.value.trim().length > 0) {
                      setOpenStep(3);
                    }
                  }}
                  className="clarification-helper-textarea"
                  rows={3}
                  placeholder="Timeline, team size, existing infrastructure, budget ceiling…"
                />
              </div>
            ) : null}
          </section>

          <section className="clarification-step">
            <button
              type="button"
              disabled={disabled}
              className="clarification-step-toggle"
              onClick={() => setOpenStep(3)}
              aria-expanded={openStep === 3}
            >
              <span>3) Answers to open questions</span>
              <span className="inline-flex items-center gap-1 text-xs text-friction-muted">
                {step3Done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                {previewText(answers, questions.length ? `${questions.length} question${questions.length > 1 ? "s" : ""}` : "Optional")}
                <ChevronDown className={["h-3.5 w-3.5 transition-transform", openStep === 3 ? "rotate-180" : ""].join(" ")} />
              </span>
            </button>

            {openStep === 3 ? (
              <div className="clarification-step-body">
                <textarea
                  value={answers}
                  disabled={disabled}
                  onChange={(event) => onAnswersChange(event.target.value)}
                  className="clarification-helper-textarea"
                  rows={4}
                  placeholder="Answer unresolved questions one by one…"
                />

                {questions.length > 0 ? (
                  <section className="clarification-helper-questions">
                    <div className="flex items-center justify-between gap-2">
                      <p className="panel-label">Open questions from agents</p>
                      {questions.length > 1 ? (
                        <button
                          type="button"
                          className="text-xs font-semibold text-friction-muted underline-offset-2 hover:underline"
                          onClick={() => setShowAllQuestions((value) => !value)}
                        >
                          {showAllQuestions ? "Show less" : "View all"}
                        </button>
                      ) : null}
                    </div>
                    <ul className="mt-2 space-y-1 text-xs text-friction-muted">
                      {questionsPreview.map((question, index) => (
                        <li key={`${question}-${index}`} className="flex items-start gap-2">
                          <span aria-hidden="true">{index + 1}.</span>
                          <span>{question}</span>
                        </li>
                      ))}
                    </ul>
                    {!showAllQuestions && questions.length > 1 ? (
                      <p className="mt-2 text-[11px] text-friction-muted">+{questions.length - 1} more</p>
                    ) : null}
                  </section>
                ) : (
                  <p className="text-xs text-friction-muted">No open question detected. Send once constraints are clear.</p>
                )}
              </div>
            ) : null}
          </section>
        </>
      ) : null}
    </section>
  );
}
