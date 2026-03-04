import type { AppPhase, RouteState } from "./types";

export const DEFAULT_ROUTE_STATE: RouteState = {
  phase: 1,
  sessionId: null
};

function isPhase(value: string | null): value is `${AppPhase}` {
  return value === "1" || value === "2" || value === "3";
}

export function parseRouteState(search: string): RouteState {
  const params = new URLSearchParams(search);
  return {
    phase: (isPhase(params.get("phase")) ? Number(params.get("phase")) : 1) as AppPhase,
    sessionId: params.get("session") || null
  };
}

export function buildSearchFromRouteState(state: RouteState): string {
  const params = new URLSearchParams();
  params.set("phase", String(state.phase));
  if (state.sessionId) params.set("session", state.sessionId);

  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

export function applyRouteState(state: RouteState, mode: "replace" | "push" = "replace") {
  const nextUrl = `${window.location.pathname}${buildSearchFromRouteState(state)}`;
  const nextState = {
    ...(window.history.state ?? {}),
    frictionRouteKey: crypto.randomUUID()
  };

  if (mode === "push") {
    window.history.pushState(nextState, "", nextUrl);
    return;
  }

  window.history.replaceState(nextState, "", nextUrl);
}

export function readRouteStateFromLocation(): RouteState {
  return parseRouteState(window.location.search);
}
