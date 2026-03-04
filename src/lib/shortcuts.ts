import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export function installGlobalShortcuts(): () => void {
  return () => {
    // No global shortcuts in chat-first workflow.
  };
}

export function isSubmitCombo(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
  if (event.key !== "Enter") return false;
  return event.metaKey || event.ctrlKey;
}
