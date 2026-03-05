import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

interface CodeCardProps {
  title: string;
  summary: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function CodeCard({ title, summary, defaultOpen = false, children }: CodeCardProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  useEffect(() => {
    setIsOpen(defaultOpen);
  }, [defaultOpen]);

  return (
    <section className="chat-collapsible-card">
      <button
        type="button"
        className="chat-collapsible-summary w-full border-0 bg-transparent text-left"
        onClick={() => setIsOpen((value) => !value)}
      >
        <div>
          <p className="text-sm font-semibold text-friction-text">{title}</p>
          <p className="mt-1 text-xs text-friction-muted">{summary}</p>
        </div>
        <ChevronRight
          className={`chat-collapsible-icon h-4 w-4 text-friction-muted ${isOpen ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
      </button>
      {isOpen ? <div className="chat-collapsible-content">{children}</div> : null}
    </section>
  );
}
