/**
 * Cron schedules ("*\/15 * * * *") → systemd OnCalendar ("*-*-* *:00/15:00").
 * HostPanel runs cron jobs as systemd timers so they get the account's CPU/RAM limits,
 * a time limit and a log file. Supports the standard 5 fields with *, lists, ranges,
 * steps, month/day names, and the @hourly / @daily / @weekly / @monthly / @yearly shortcuts.
 */

const SHORTCUTS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const SYSTEMD_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: string[];
  namesStart?: number;
}

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, namesStart: 1 },
  { name: "day of week", min: 0, max: 7, names: DAYS, namesStart: 0 },
];

export class CronError extends Error {}

function num(token: string, f: FieldSpec): number {
  const lower = token.toLowerCase();
  if (f.names) {
    const i = f.names.indexOf(lower);
    if (i >= 0) return i + (f.namesStart ?? 0);
  }
  if (!/^\d+$/.test(token)) throw new CronError(`'${token}' is not valid in the ${f.name} field`);
  const n = Number(token);
  if (n < f.min || n > f.max) throw new CronError(`${f.name} must be between ${f.min} and ${f.max}`);
  return n;
}

/** Expand one field to the sorted list of values it matches, or null for "*". */
function expand(field: string, f: FieldSpec): number[] | null {
  if (field === "*") return null;
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepStr] = part.split("/");
    if (range === undefined || range === "") throw new CronError(`Empty value in the ${f.name} field`);
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (!Number.isInteger(step) || step < 1) throw new CronError(`Bad step '${stepStr}' in the ${f.name} field`);
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = f.min;
      hi = f.max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = num(a!, f);
      hi = num(b!, f);
      if (lo > hi) throw new CronError(`Range ${range} goes backwards in the ${f.name} field`);
    } else {
      lo = num(range, f);
      hi = stepStr === undefined ? lo : f.max;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

function list(values: number[] | null, pad: number): string {
  if (values === null) return "*";
  return values.map((v) => String(v).padStart(pad, "0")).join(",");
}

/** Returns the systemd OnCalendar expression; throws CronError with a readable message. */
export function cronToOnCalendar(expr: string): string {
  const src = SHORTCUTS[expr.trim().toLowerCase()] ?? expr.trim();
  const parts = src.split(/\s+/);
  if (parts.length !== 5) throw new CronError("Use 5 fields: minute hour day-of-month month day-of-week");
  const [min, hour, dom, mon, dow] = parts.map((p, i) => expand(p, FIELDS[i]!)) as (number[] | null)[];
  if (dom && dow) {
    // cron means "either", systemd means "both": refuse rather than run at surprising times.
    throw new CronError("Set either day-of-month or day-of-week, not both");
  }
  if (min && min.length === 60) throw new CronError("Use * instead of listing every minute");
  const days = dow ? [...new Set(dow.map((d) => SYSTEMD_DAYS[d % 7]!))].join(",") + " " : "";
  return `${days}*-${list(mon, 2)}-${list(dom, 2)} ${list(hour, 2)}:${list(min ?? [], 2) || "*"}:00`;
}

export function isValidCron(expr: string): boolean {
  try {
    cronToOnCalendar(expr);
    return true;
  } catch {
    return false;
  }
}

export const CRON_PRESETS = [
  { label: "Every 5 minutes", value: "*/5 * * * *" },
  { label: "Every 15 minutes", value: "*/15 * * * *" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every day at 02:00", value: "0 2 * * *" },
  { label: "Every Monday at 09:00", value: "0 9 * * 1" },
  { label: "First day of the month", value: "0 0 1 * *" },
] as const;
