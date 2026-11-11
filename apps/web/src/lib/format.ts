export const short = (s: string, head = 6, tail = 4) => (s.length > head + tail + 2 ? `${s.slice(0, head + 2)}…${s.slice(-tail)}` : s);

export function fmtTime(ts: bigint | number): string {
  const d = new Date(Number(ts) * 1000);
  return `${d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} (${d.toISOString().replace("T", " ").slice(0, 16)} UTC)`;
}

export function fmtRelative(target: bigint, now: bigint): string {
  const diff = Number(target - now);
  const abs = Math.abs(diff);
  const h = Math.floor(abs / 3600), m = Math.floor((abs % 3600) / 60), s = abs % 60;
  const text = h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

export function fmtDuration(seconds: bigint | number): string {
  const s = Number(seconds);
  if (s % 86400 === 0) return `${s / 86400} day${s / 86400 === 1 ? "" : "s"}`;
  if (s % 3600 === 0) return `${s / 3600} hour${s / 3600 === 1 ? "" : "s"}`;
  if (s % 60 === 0) return `${s / 60} min`;
  return `${s} s`;
}
