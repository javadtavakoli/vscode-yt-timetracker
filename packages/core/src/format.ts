/** Format ms as `Dd:Hh:MMm:SSs`. One day = 8 hours (working day). */
export function formatDhms(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const days = Math.floor(totalSecs / 28800); // 8h day
  const rem = totalSecs % 28800;
  const h = Math.floor(rem / 3600);
  const m = Math.floor((rem % 3600) / 60);
  const s = rem % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  parts.push(`${h}h`);
  parts.push(`${String(m).padStart(2, "0")}m`);
  parts.push(`${String(s).padStart(2, "0")}s`);
  return parts.join(":");
}

/** Format ms as a coarse `Xh Ym` (or `Ym` if < 1h). For toasts. */
export function formatDuration(ms: number): string {
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}
