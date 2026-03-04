import { Loader2, Wrench } from "lucide-react";

interface ToolEventCardProps {
  title: string;
  detail?: string;
  running?: boolean;
}

export function ToolEventCard({ title, detail, running }: ToolEventCardProps) {
  return (
    <article className="chat-tool-card" aria-live="polite">
      <div className="flex items-center gap-2">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-friction-border bg-friction-surface-alt" aria-hidden="true">
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}
        </span>
        <p className="text-sm font-semibold text-friction-text">{title}</p>
      </div>
      {detail ? <p className="mt-2 text-sm text-friction-muted">{detail}</p> : null}
    </article>
  );
}
