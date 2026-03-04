import type { FrictionSession } from "./types";

export function exportSessionToJson(session: FrictionSession): string {
  return JSON.stringify(session, null, 2);
}

export function downloadSession(session: FrictionSession): void {
  const payload = exportSessionToJson(session);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `friction-session-${session.id}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  URL.revokeObjectURL(url);
}
