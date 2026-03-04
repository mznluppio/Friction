import * as React from "react";
import { cn } from "../../lib/utils";

type BadgeTone = "neutral" | "glow" | "ember" | "warning";

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

const tones: Record<BadgeTone, string> = {
  neutral: "bg-friction-surfaceAlt border-friction-border text-friction-muted",
  glow: "bg-friction-surfaceAlt border-friction-border text-friction-text",
  ember: "bg-friction-surfaceAlt border-friction-border text-friction-text",
  warning: "bg-friction-surfaceAlt border-friction-text text-friction-text"
};

export function Badge({ className, tone = "neutral", ...props }: BadgeProps) {
  return <span className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold", tones[tone], className)} {...props} />;
}
