// User-facing duration spans (Chris, 2026-08-14: "don't use 148min, use
// 2h 28min"). One formatter for every surface that shows a span of minutes —
// engine conflict details, trade-off cards, proposal chips, margin notes,
// sidebar waits/legs. Clock times (12:30) are a different thing and stay with
// their local hh:mm helpers.
//
// CEILs fractional minutes: spans reaching users come from float schedule
// math, and "off by N" copy already ceils `violatedByMin` — one rounding rule
// everywhere or two surfaces show different numbers for the same breach.
export function formatDuration(min: number): string {
  const m = Math.ceil(Math.max(0, min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h}h` : `${h}h ${r}min`;
}
