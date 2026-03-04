import { ArrowUp } from "lucide-react";
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect } from "react";

interface PromptComposerProps {
  value: string;
  disabled?: boolean;
  placeholder: string;
  submitLabel: string;
  accessory?: ReactNode;
  textareaRef?: RefObject<HTMLTextAreaElement>;
  onChange: (value: string) => void;
  onSubmit: () => void;
}

export function PromptComposer({
  value,
  disabled,
  placeholder,
  accessory,
  textareaRef,
  onChange,
  onSubmit
}: PromptComposerProps) {
  // Auto-resize textarea to fit content
  useEffect(() => {
    const el = textareaRef?.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value, textareaRef]);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter") return;
    if (event.shiftKey) return;
    if (disabled) return;
    event.preventDefault();
    onSubmit();
  }

  const canSubmit = !disabled && value.trim().length > 0;

  return (
    <section className="chat-composer-wrap" aria-label="Prompt composer">
      {accessory ? <div className="chat-composer-accessory">{accessory}</div> : null}

      {/* Unified card — same pattern as ai-elements PromptInput */}
      <div className="prompt-card">
        <label className="sr-only" htmlFor="workflow_prompt">
          Workflow input
        </label>
        <textarea
          id="workflow_prompt"
          ref={textareaRef}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className="prompt-card-textarea"
          rows={1}
        />
        <div className="prompt-card-footer">
          <span className="prompt-card-hint">
            Enter to send · Shift+Enter for new line
          </span>
          <button
            type="button"
            aria-label="Send"
            disabled={!canSubmit}
            onClick={onSubmit}
            className="prompt-card-submit"
          >
            <ArrowUp className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  );
}
