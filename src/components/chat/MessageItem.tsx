import { Bot, User, Wrench, AlertTriangle } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../../lib/utils";

export type MessageTone = "user" | "assistant" | "status" | "error";

interface MessageItemProps {
  tone: MessageTone;
  text: string;
  label?: string;
}

export function MessageItem({ tone, text, label }: MessageItemProps) {
  if (text.trim().length === 0) {
    return null;
  }

  const isUser = tone === "user";
  const isStatus = tone === "status";
  const isError = tone === "error";

  if (isStatus) {
    return (
      <article
        className={cn(
          "chat-message-wrap is-status",
          "flex items-start gap-2 px-1"
        )}
      >
        <span
          className="mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full"
          style={{ color: "var(--friction-accent)" }}
          aria-hidden="true"
        >
          <Wrench className="h-3 w-3" />
        </span>
        <div className="chat-message-text text-xs" style={{ color: "var(--friction-muted)" }}>
          {label ? <strong className="font-semibold">{label}: </strong> : null}
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
      </article>
    );
  }

  if (isError) {
    return (
      <article className="chat-message-wrap is-error flex">
        <div className="chat-message" role="alert">
          <div className="chat-message-head">
            <span
              className="inline-flex h-5 w-5 items-center justify-center rounded-full"
              style={{ background: "var(--friction-danger-soft)", color: "var(--friction-danger)" }}
              aria-hidden="true"
            >
              <AlertTriangle className="h-3.5 w-3.5" />
            </span>
            {label ? (
              <p className="text-xs font-semibold" style={{ color: "var(--friction-danger-text)" }}>
                {label}
              </p>
            ) : null}
          </div>
          <div className="chat-message-text">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className={cn("chat-message-wrap", isUser && "chat-message-wrap-user")}>
      <div className="chat-message">
        {!isUser && (
          <div className="chat-message-head">
            <span
              className="inline-flex h-6 w-6 items-center justify-center rounded-full border"
              style={{
                borderColor: "var(--friction-border)",
                background: "var(--friction-surface-alt)",
                color: "var(--friction-muted)",
              }}
              aria-hidden="true"
            >
              <Bot className="h-3.5 w-3.5" />
            </span>
            <p
              className="text-xs font-semibold uppercase tracking-[0.06em]"
              style={{ color: "var(--friction-muted)" }}
            >
              {label ?? "Assistant"}
            </p>
          </div>
        )}
        {isUser && label ? (
          <div className="chat-message-head">
            <span
              className="inline-flex h-6 w-6 items-center justify-center rounded-full"
              style={{ background: "rgba(255,255,255,0.2)", color: "white" }}
              aria-hidden="true"
            >
              <User className="h-3.5 w-3.5" />
            </span>
            <p className="text-xs font-semibold uppercase tracking-[0.06em] text-white/70">
              {label}
            </p>
          </div>
        ) : null}
        <div className="chat-message-text">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
      </div>
    </article>
  );
}
