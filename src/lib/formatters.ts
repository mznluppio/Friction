import type { AttackReportItem, Complexity } from "./types";

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short"
});

const numberFormatter = new Intl.NumberFormat(undefined);

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return dateTimeFormatter.format(date);
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function formatCount(value: number): string {
  return numberFormatter.format(value);
}

export function complexityLabel(value: Complexity | "all"): string {
  if (value === "all") return "All complexity";
  return value[0].toUpperCase() + value.slice(1);
}

export function severityRank(item: AttackReportItem): number {
  if (item.severity === "high") return 3;
  if (item.severity === "medium") return 2;
  return 1;
}
