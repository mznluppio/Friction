import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Ansi from "ansi-to-react";
import { Check, Copy, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface TerminalContextValue {
  output: string;
  isStreaming: boolean;
  autoScroll: boolean;
  tone: "dark" | "light";
  onClear?: () => void;
}

const TerminalContext = createContext<TerminalContextValue | null>(null);

function useTerminalContext(): TerminalContextValue {
  const context = useContext(TerminalContext);
  if (!context) {
    throw new Error("Terminal compound components must be used within <Terminal />");
  }
  return context;
}

export interface TerminalProps extends React.HTMLAttributes<HTMLDivElement> {
  output: string;
  isStreaming?: boolean;
  autoScroll?: boolean;
  tone?: "dark" | "light";
  onClear?: () => void;
}

export function Terminal({
  output,
  isStreaming = false,
  autoScroll = true,
  tone = "dark",
  onClear,
  className,
  children,
  ...props
}: TerminalProps) {
  const value = useMemo(
    () => ({
      output,
      isStreaming,
      autoScroll,
      tone,
      onClear,
    }),
    [autoScroll, isStreaming, onClear, output, tone],
  );

  return (
    <TerminalContext.Provider value={value}>
      <section
        className={cn(
          "w-full min-w-0 overflow-hidden rounded-xl border shadow-sm",
          tone === "light"
            ? "border-[#d8d8d8] bg-[#f7f7f7] text-slate-800"
            : "border-friction-border bg-[#0f1116] text-slate-100",
          className,
        )}
        {...props}
      >
        {children}
      </section>
    </TerminalContext.Provider>
  );
}

export function TerminalHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const { tone } = useTerminalContext();
  return (
    <div
      className={cn(
        "flex items-center justify-between border-b px-3 py-2.5",
        tone === "light"
          ? "border-[#d8d8d8] bg-[#efefef]"
          : "border-white/10 bg-[#141923]",
        className,
      )}
      {...props}
    />
  );
}

export function TerminalTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const { tone } = useTerminalContext();
  return (
    <div
      className={cn(
        "truncate text-xs font-medium uppercase tracking-[0.08em]",
        tone === "light" ? "text-slate-700" : "text-slate-300",
        className,
      )}
      {...props}
    />
  );
}

export function TerminalStatus({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const { isStreaming, tone } = useTerminalContext();
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 text-[11px]",
        tone === "light" ? "text-slate-500" : "text-slate-400",
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          isStreaming
            ? tone === "light"
              ? "animate-pulse bg-emerald-500"
              : "animate-pulse bg-emerald-400"
            : tone === "light"
              ? "bg-slate-400"
              : "bg-slate-600",
        )}
        aria-hidden="true"
      />
      {isStreaming ? "Streaming" : "Idle"}
    </div>
  );
}

export function TerminalActions({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("inline-flex items-center gap-1", className)} {...props} />
  );
}

export interface TerminalCopyButtonProps
  extends Omit<React.ComponentProps<typeof Button>, "onCopy" | "onError"> {
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
}

export function TerminalCopyButton({
  onCopy,
  onError,
  timeout = 2000,
  className,
  ...props
}: TerminalCopyButtonProps) {
  const { output, tone } = useTerminalContext();
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      onCopy?.();
      window.setTimeout(() => setCopied(false), timeout);
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error("Copy failed"));
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn(
        "h-7 w-7",
        tone === "light"
          ? "text-slate-500 hover:bg-black/5 hover:text-slate-800"
          : "text-slate-300 hover:bg-white/10 hover:text-white",
        className,
      )}
      onClick={handleCopy}
      title={copied ? "Copied" : "Copy output"}
      {...props}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      <span className="sr-only">{copied ? "Copied" : "Copy output"}</span>
    </Button>
  );
}

export function TerminalClearButton(props: React.ComponentProps<typeof Button>) {
  const { onClear, tone } = useTerminalContext();

  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn(
        "h-7 w-7",
        tone === "light"
          ? "text-slate-500 hover:bg-black/5 hover:text-slate-800"
          : "text-slate-300 hover:bg-white/10 hover:text-white",
      )}
      onClick={onClear}
      disabled={!onClear}
      title="Clear output"
      {...props}
    >
      <Trash2 className="h-3.5 w-3.5" />
      <span className="sr-only">Clear output</span>
    </Button>
  );
}

export function TerminalContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const { output, isStreaming, autoScroll, tone } = useTerminalContext();
  const viewportRef = useRef<HTMLDivElement>(null);

  function handleWheelCapture(event: React.WheelEvent<HTMLDivElement>) {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const canScrollY = viewport.scrollHeight > viewport.clientHeight;
    if (canScrollY && event.deltaY !== 0) {
      const atTop = viewport.scrollTop <= 0;
      const atBottom =
        viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 1;
      const scrollingUpInside = event.deltaY < 0 && !atTop;
      const scrollingDownInside = event.deltaY > 0 && !atBottom;
      if (scrollingUpInside || scrollingDownInside) {
        event.stopPropagation();
      }
    }

    const canScrollX = viewport.scrollWidth > viewport.clientWidth;
    if (canScrollX && event.deltaX !== 0) {
      const atLeft = viewport.scrollLeft <= 0;
      const atRight =
        viewport.scrollLeft + viewport.clientWidth >= viewport.scrollWidth - 1;
      const scrollingLeftInside = event.deltaX < 0 && !atLeft;
      const scrollingRightInside = event.deltaX > 0 && !atRight;
      if (scrollingLeftInside || scrollingRightInside) {
        event.stopPropagation();
      }
    }
  }

  useEffect(() => {
    if (!autoScroll || !viewportRef.current) return;
    viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
  }, [autoScroll, output, isStreaming]);

  return (
    <div
      ref={viewportRef}
      tabIndex={0}
      onWheelCapture={handleWheelCapture}
      className={cn(
        "h-56 overflow-y-auto overflow-x-hidden overscroll-contain px-3 py-2.5 font-mono text-[12px] leading-relaxed",
        tone === "light" ? "text-slate-800" : "text-slate-100",
        className,
      )}
      {...props}
    >
      <pre className="whitespace-pre-wrap break-all">
        <Ansi>{output}</Ansi>
        {isStreaming ? (
          <span className="ml-0.5 inline-block animate-pulse text-emerald-400">▋</span>
        ) : null}
      </pre>
    </div>
  );
}
