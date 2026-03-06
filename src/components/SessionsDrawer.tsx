import * as Dialog from "@radix-ui/react-dialog";
import { Download, Save, Settings2, X } from "lucide-react";
import { formatDateTime } from "../lib/formatters";
import type { SessionSummary } from "../lib/types";
import { Button } from "./ui/button";

interface SessionsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  onLoadSession: (id: string) => void;
  onOpenSettings: () => void;
  onNewSession: () => void;
  onSaveSession: () => void;
  onExportSession: () => void;
  canPersistSession: boolean;
  saveLocalLoading: boolean;
}

export function SessionsDrawer({
  open,
  onOpenChange,
  sessions,
  activeSessionId,
  onLoadSession,
  onOpenSettings,
  onSaveSession,
  onExportSession,
  canPersistSession,
  saveLocalLoading
}: SessionsDrawerProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[1px]" />
        <Dialog.Content className="sessions-drawer-panel">
          <header className="flex items-start justify-between gap-3 border-b border-friction-border pb-3">
            <div>
              <Dialog.Title className="text-base font-semibold text-friction-text">Sessions</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-friction-muted">
                Load an auto-saved session or snapshot.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="btn btn-ghost min-h-9 px-2.5" aria-label="Close sessions">
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </Dialog.Close>
          </header>

          <div className="sessions-scroll mt-3 pr-0">
            {sessions.length === 0 ? (
              <p className="text-sm text-friction-muted">No saved sessions yet.</p>
            ) : (
              sessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => {
                    onLoadSession(session.id);
                    onOpenChange(false);
                  }}
                  className={[
                    "session-row w-full text-left",
                    activeSessionId === session.id ? "session-row-selected" : ""
                  ].join(" ")}
                >
                  <div className="session-row-main">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-friction-text">{session.title}</p>
                      <span className="inline-flex min-h-6 items-center rounded-full border border-friction-border px-2 text-[10px] uppercase tracking-[0.12em] text-friction-muted">
                        {session.status.replace("_", " ")}
                      </span>
                    </div>
                    <p className="line-clamp-2 text-xs text-friction-muted">{session.problemPreview}</p>
                    <p className="text-xs text-friction-muted">
                      {session.domain} · {session.complexity} · {formatDateTime(session.updatedAt)}
                    </p>
                  </div>
                </button>
              ))
            )}
          </div>

          <footer className="sessions-actions mt-3">
            <Button
              variant="ghost"
              className="w-full justify-start"
              onClick={() => {
                onOpenSettings();
                onOpenChange(false);
              }}
            >
              <Settings2 className="h-4 w-4" aria-hidden="true" />
              Settings
            </Button>

            <Button
              variant="ghost"
              className="w-full justify-start"
              onClick={() => {
                onSaveSession();
                onOpenChange(false);
              }}
              disabled={!canPersistSession || saveLocalLoading}
            >
              <Save className="h-4 w-4" aria-hidden="true" />
              {saveLocalLoading ? "Saving…" : "Snapshot"}
            </Button>
            <Button
              variant="ghost"
              className="w-full justify-start"
              onClick={() => {
                onExportSession();
                onOpenChange(false);
              }}
              disabled={!canPersistSession}
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              Export
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
