declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  }
}

function inTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return (
    typeof window.__TAURI_INTERNALS__ !== "undefined" ||
    typeof window.__TAURI__ !== "undefined"
  );
}

export async function invokeCommand<T>(command: string, payload: Record<string, unknown>): Promise<T> {
  if (!inTauriRuntime()) {
    throw new Error("Tauri runtime unavailable");
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, payload);
}

export function canUseTauriCommands(): boolean {
  return inTauriRuntime();
}
