import { GitCompare, ShieldAlert } from "lucide-react";
import type { Phase3Result } from "../lib/types";
import { formatPercent } from "../lib/formatters";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

interface DiffViewerProps {
  phase3: Phase3Result;
}

function confidenceTone(score: number): "warning" | "neutral" | "glow" {
  if (score < 0.6) return "warning";
  if (score > 0.82) return "glow";
  return "neutral";
}

export function DiffViewer({ phase3 }: DiffViewerProps) {
  return (
    <div className="space-y-5">
      <div className="grid gap-4 2xl:grid-cols-2">
        <CodeCard title="Agent A final code" code={phase3.codeA} />

        <CodeCard title="Agent B · Attack report source" code={phase3.codeB} />
      </div>

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <GitCompare className="h-4 w-4 text-friction-accentText" aria-hidden="true" />
            Diff base to candidate
          </CardTitle>
          <div className="flex items-center gap-2">
            {phase3.workflowMode ? <Badge tone="neutral">{phase3.workflowMode}</Badge> : null}
            {phase3.sessionId ? <Badge tone="neutral">session {phase3.sessionId.slice(0, 8)}</Badge> : null}
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          {phase3.agentABranch && phase3.agentBBranch ? (
            <div className="rounded-md border border-friction-border bg-friction-surfaceAlt px-3 py-2 text-xs text-friction-text">
              <p>Candidate branch: {phase3.agentABranch}</p>
              <p>Base branch: {phase3.agentBBranch}</p>
              {phase3.adrPath ? <p>ADR: {phase3.adrPath}</p> : null}
            </div>
          ) : null}
          <pre className="max-h-80 overflow-auto rounded-lg border border-friction-border bg-friction-surfaceAlt p-3 font-mono text-xs text-friction-text">
            <code>{phase3.gitDiff?.trim() ? phase3.gitDiff : "No diff available"}</code>
          </pre>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-friction-warningText" aria-hidden="true" />
            Adversarial report
          </CardTitle>
          <Badge tone={confidenceTone(phase3.confidenceScore)}>Confidence {formatPercent(phase3.confidenceScore)}</Badge>
        </CardHeader>

        <CardContent className="space-y-3">
          {phase3.attackReport.length === 0 ? (
            <p className="text-sm text-friction-muted">No findings were reported.</p>
          ) : (
            phase3.attackReport.map((item) => (
              <article key={item.title} className="rounded-md border border-friction-border bg-friction-surfaceAlt p-3">
                <div className="mb-1 flex items-center justify-between">
                  <p className="text-sm font-semibold text-friction-text">{item.title}</p>
                  <Badge tone={item.severity === "high" ? "warning" : "neutral"}>{item.severity}</Badge>
                </div>
                <p className="text-sm text-friction-muted">{item.detail}</p>
              </article>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CodeCard({ title, code }: { title: string; code: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <pre className="max-h-72 overflow-x-auto overflow-y-auto rounded-lg border border-friction-border bg-friction-surfaceAlt p-3 font-mono text-xs text-friction-text">
          <code>{code}</code>
        </pre>
      </CardContent>
    </Card>
  );
}
