import type { Divergence } from "./types";

function normalize(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[\W_]+/g, " ")
    .replace(/\s+/g, " ");
}

function severityFromDelta(delta: number): Divergence["severity"] {
  if (delta >= 3) {
    return "high";
  }
  if (delta === 2) {
    return "medium";
  }
  return "low";
}

export function getDivergences<T extends object>(
  a: T,
  b: T,
  fields: string[]
): Divergence[] {
  const divergences: Divergence[] = [];

  for (const field of fields) {
    const left = (a as Record<string, unknown>)[field];
    const right = (b as Record<string, unknown>)[field];

    if (Array.isArray(left) && Array.isArray(right)) {
      const leftNorm = new Set(left.map((item) => normalize(String(item))));
      const rightNorm = new Set(right.map((item) => normalize(String(item))));

      const uniqueA = left.filter((item) => !rightNorm.has(normalize(String(item))));
      const uniqueB = right.filter((item) => !leftNorm.has(normalize(String(item))));

      if (uniqueA.length > 0 || uniqueB.length > 0) {
        divergences.push({
          field,
          uniqueA: uniqueA.map(String),
          uniqueB: uniqueB.map(String),
          severity: severityFromDelta(Math.abs(uniqueA.length - uniqueB.length) + 1)
        });
      }
      continue;
    }

    if (typeof left === "string" && typeof right === "string") {
      if (normalize(left) !== normalize(right)) {
        divergences.push({
          field,
          a: left,
          b: right,
          severity: "medium"
        });
      }
    }
  }

  return divergences;
}
