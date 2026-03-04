import type { WorkflowStep } from "../../lib/types";

interface TaskRailProps {
  currentStep: WorkflowStep;
}

const STEPS: { key: WorkflowStep; label: string; short: string }[] = [
  { key: "requirement", label: "Requirement", short: "1" },
  { key: "clarifications", label: "Clarify", short: "2" },
  { key: "decision", label: "Decision", short: "3" },
  { key: "phase3_config", label: "Validate", short: "4" },
  { key: "completed", label: "Done", short: "✓" },
];

const STEP_ORDER: WorkflowStep[] = [
  "requirement",
  "clarifications",
  "decision",
  "phase3_config",
  "phase3_run",
  "completed",
];

function stepIndex(step: WorkflowStep): number {
  return STEP_ORDER.indexOf(step);
}

export function TaskRail({ currentStep }: TaskRailProps) {
  const currentIndex = stepIndex(currentStep);
  const isCompleted = currentStep === "completed";

  return (
    <nav className="task-rail" aria-label="Workflow progress">
      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", alignItems: "center", gap: 4 }}>
        {STEPS.map((step, idx) => {
          const stepIdx = stepIndex(step.key);
          const isDone = isCompleted || stepIdx < currentIndex;
          const isCurrent =
            step.key === currentStep ||
            (currentStep === "phase3_run" && step.key === "phase3_config");
          const isPending = !isDone && !isCurrent;

          return (
            <li key={step.key} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>
                {/* Circle indicator */}
                <span
                  aria-current={isCurrent ? "step" : undefined}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 20,
                    height: 20,
                    borderRadius: "50%",
                    fontSize: 9,
                    fontWeight: 700,
                    flexShrink: 0,
                    transition: "background 200ms ease, border-color 200ms ease, color 200ms ease",
                    ...(isDone
                      ? {
                        background: "var(--friction-text)",
                        color: "var(--friction-surface)",
                        border: "none",
                      }
                      : isCurrent
                        ? {
                          background: "transparent",
                          color: "var(--friction-text)",
                          border: "2px solid var(--friction-text)",
                        }
                        : {
                          background: "transparent",
                          color: "var(--friction-muted)",
                          border: "1px solid var(--friction-border)",
                        }),
                  }}
                >
                  {isDone ? "✓" : step.short}
                </span>

                {/* Label */}
                <span
                  className="hidden sm:inline"
                  style={{
                    fontSize: 11.5,
                    fontWeight: isCurrent ? 600 : 400,
                    color: isPending
                      ? "var(--friction-muted)"
                      : "var(--friction-text)",
                    transition: "color 200ms ease",
                  }}
                >
                  {step.label}
                </span>
              </div>

              {/* Connector line */}
              {idx < STEPS.length - 1 && (
                <span
                  aria-hidden="true"
                  className="hidden sm:block"
                  style={{
                    width: 16,
                    height: 1,
                    marginLeft: 2,
                    background: isDone
                      ? "var(--friction-text)"
                      : "var(--friction-border)",
                    flexShrink: 0,
                    transition: "background 300ms ease",
                  }}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
