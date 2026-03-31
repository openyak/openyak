import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { PartData, TextPart } from "@/types/message";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatRelativeTime(date: string | Date): string {
  const now = new Date();
  const d = new Date(date);
  const diff = now.getTime() - d.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;

  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 1) + "\u2026";
}

/** Extract joined text from an array of PartData (e.g. message.parts.map(p => p.data)). */
export function extractTextFromParts(parts: PartData[]): string {
  return parts
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

/** Extract joined text from PartResponse[] (API response shape with nested .data). */
export function extractTextFromPartResponses(parts: Array<{ data: PartData }>): string {
  return parts
    .filter((p) => p.data.type === "text")
    .map((p) => (p.data as TextPart).text)
    .join("\n");
}

export function groupSessionsByDate<T extends { time_updated: string }>(
  sessions: T[],
): { label: string; sessions: T[] }[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);
  const monthAgo = new Date(today.getTime() - 30 * 86400000);

  const groups: Record<string, T[]> = {
    today: [],
    yesterday: [],
    previous7Days: [],
    previous30Days: [],
    older: [],
  };

  for (const session of sessions) {
    const d = new Date(session.time_updated);
    if (d >= today) groups["today"].push(session);
    else if (d >= yesterday) groups["yesterday"].push(session);
    else if (d >= weekAgo) groups["previous7Days"].push(session);
    else if (d >= monthAgo) groups["previous30Days"].push(session);
    else groups["older"].push(session);
  }

  return Object.entries(groups)
    .filter(([, items]) => items.length > 0)
    .map(([label, items]) => ({ label, sessions: items }));
}
