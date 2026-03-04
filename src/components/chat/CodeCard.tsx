import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

interface CodeCardProps {
  title: string;
  summary: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function CodeCard({ title, summary, defaultOpen = false, children }: CodeCardProps) {
  return (
    <details className="chat-collapsible-card" open={defaultOpen}>
      <summary className="chat-collapsible-summary">
        <div>
          <p className="text-sm font-semibold text-friction-text">{title}</p>
          <p className="mt-1 text-xs text-friction-muted">{summary}</p>
        </div>
        <ChevronRight className="chat-collapsible-icon h-4 w-4 text-friction-muted" aria-hidden="true" />
      </summary>
      <div className="chat-collapsible-content">{children}</div>
    </details>
  );
}
