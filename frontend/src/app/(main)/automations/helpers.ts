import type { ScheduleConfig } from "@/types/automation";

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

export function humanizeSchedule(config: ScheduleConfig, t: TFunc): string {
  if (config.type === "cron" && config.cron) return humanizeCron(config.cron, t);
  if (config.type === "interval") {
    const h = config.hours || 0;
    const m = config.minutes || 0;
    if (h > 0 && m > 0) return t("everyHM", { h, m });
    if (h > 0) return t("everyNHours", { n: h });
    if (m > 0) return t("everyNMinutes", { n: m });
  }
  return "—";
}

export function humanizeCron(cron: string, t: TFunc): string {
  const parts = cron.split(" ");
  if (parts.length < 5) return cron;
  const [min, hour, , , dow] = parts;
  const time = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  const dayKeys: Record<string, string> = {
    "0": "sun", "1": "mon", "2": "tue", "3": "wed",
    "4": "thu", "5": "fri", "6": "sat", "7": "sun",
    "*": "everyday", "1-5": "weekdays", "0,6": "weekends",
  };
  const dayKey = dayKeys[dow];
  const dayLabel = dayKey ? t(`days.${dayKey}`) : dow;
  return `${dayLabel} ${time}`;
}

export function relativeTime(iso: string | null, t: TFunc): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t("justNow");
  if (mins < 60) return t("minutesAgo", { n: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t("hoursAgo", { n: hrs });
  const days = Math.floor(hrs / 24);
  return t("daysAgo", { n: days });
}

export function formatTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

export function formatDuration(startIso: string | null, endIso: string | null): string {
  if (!startIso || !endIso) return "";
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (ms < 1000) return "<1s";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

/** Parse a cron string into { minute, hour, dow } for the visual editor. */
export function parseCron(cron: string): { minute: number; hour: number; dow: number[] } {
  const parts = cron.split(" ");
  if (parts.length < 5) return { minute: 0, hour: 8, dow: [] };
  const [minStr, hourStr, , , dowStr] = parts;
  const minute = parseInt(minStr) || 0;
  const hour = parseInt(hourStr) || 0;
  let dow: number[] = [];
  if (dowStr === "*") {
    dow = [0, 1, 2, 3, 4, 5, 6];
  } else if (dowStr === "1-5") {
    dow = [1, 2, 3, 4, 5];
  } else if (dowStr === "0,6") {
    dow = [0, 6];
  } else {
    dow = dowStr.split(",").map((s) => parseInt(s)).filter((n) => !isNaN(n));
  }
  return { minute, hour, dow };
}

/** Build a cron string from visual editor state. */
export function buildCron(hour: number, minute: number, dow: number[]): string {
  const sorted = [...dow].sort((a, b) => a - b);
  let dowStr: string;
  if (sorted.length === 0 || sorted.length === 7) {
    dowStr = "*";
  } else if (sorted.length === 5 && [1, 2, 3, 4, 5].every((d) => sorted.includes(d))) {
    dowStr = "1-5";
  } else if (sorted.length === 2 && sorted.includes(0) && sorted.includes(6)) {
    dowStr = "0,6";
  } else {
    dowStr = sorted.join(",");
  }
  return `${minute} ${hour} * * ${dowStr}`;
}
