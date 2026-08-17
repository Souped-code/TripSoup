// Positional day repair (live-verify finding, 2026-08-17): the LLM parse can
// emit off-by-one `days[].itemRefs` at day-marker boundaries — on a real prod
// paste, the FIRST place under each date line ("25 aug", "26 aug") was
// attached to the PREVIOUS day, systematically, at temperature 0. The paste
// itself is unambiguous: when the text has literal day-marker lines, an
// item's day is a POSITIONAL fact — it belongs to the last marker line above
// it — not a judgment call. This pass re-derives that fact from the raw text
// and overrides the model's grouping with it, regardless of which adapter
// (or which future model) produced the slip.
//
// Deliberately conservative — it bails (returns the parse untouched) unless
// the text confirms its own structure:
//   - fewer than two parsed days (nothing to misassign across);
//   - any day whose dateHint can't be matched to a line, in order (markers
//     must be found strictly top-to-bottom — otherwise position is not
//     trustworthy and the model's grouping stands);
// Items whose `raw` can't be located in the text keep the day the model gave
// them; items positioned ABOVE the first marker (header lines like
// "staying at …") keep their model membership too — this pass only ever
// corrects placement BETWEEN markers, never invents or removes day
// membership for unlocatable text.

import type { ParsedItinerary } from "./types";

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export function repairDayAssignments(parsed: ParsedItinerary, text: string): ParsedItinerary {
  if (parsed.days.length < 2) return parsed;

  const lines = text.split(/\r?\n/).map(norm);

  // ---- 1. locate each day's marker line, strictly in order ----------------
  const markerIdx: number[] = [];
  let searchFrom = 0;
  for (const day of parsed.days) {
    const hint = day.dateHint === undefined ? "" : norm(day.dateHint);
    if (hint === "") return parsed;
    let found = -1;
    for (let i = searchFrom; i < lines.length; i++) {
      if (lines[i] === hint || lines[i].startsWith(`${hint} `) || lines[i].startsWith(`${hint}:`)) {
        found = i;
        break;
      }
    }
    if (found === -1) return parsed;
    markerIdx.push(found);
    searchFrom = found + 1;
  }

  // ---- 2. locate each item's line (forward cursor; items are emitted in
  //         input order, so a monotonic scan disambiguates repeated text) ---
  const itemLine: Array<number | null> = [];
  let cursor = 0;
  for (const item of parsed.items) {
    const raw = norm(item.raw);
    const matches = (line: string): boolean =>
      raw !== "" && (line.includes(raw) || (line !== "" && raw.includes(line)));
    let found = -1;
    for (let i = cursor; i < lines.length; i++) {
      if (matches(lines[i])) {
        found = i;
        break;
      }
    }
    if (found === -1) {
      // fall back to an anywhere-scan (the model may emit out of order)
      for (let i = 0; i < lines.length; i++) {
        if (matches(lines[i])) {
          found = i;
          break;
        }
      }
    }
    itemLine.push(found === -1 ? null : found);
    // Consume the matched line (found + 1): the SAME text can legitimately
    // recur on different days ("Riverside Cafe" on day 1 AND day 2 — the
    // dedupe/fan-back path), and an inclusive cursor would pin every
    // recurrence to the first line. An anywhere-fallback match (found <
    // cursor) never moves the cursor backward.
    if (found !== -1) cursor = Math.max(cursor, found + 1);
  }

  // ---- 3. rebuild itemRefs from position --------------------------------
  const modelDay = new Map<number, number>();
  parsed.days.forEach((d, di) => {
    for (const ref of d.itemRefs) if (!modelDay.has(ref)) modelDay.set(ref, di);
  });

  const dayOfLine = (line: number): number | null => {
    let day: number | null = null;
    for (let d = 0; d < markerIdx.length; d++) {
      if (markerIdx[d] < line) day = d;
    }
    return day; // null → above the first marker (header territory)
  };

  const nextRefs: number[][] = parsed.days.map(() => []);
  for (let idx = 0; idx < parsed.items.length; idx++) {
    // Only items the model itself placed in SOME day are repaired — a dayless
    // item (header lines, trailing "random notes") stays dayless even when a
    // position could be computed for it: this pass corrects placement, it
    // never invents membership.
    if (!modelDay.has(idx)) continue;
    const line = itemLine[idx];
    const positional = line === null ? null : dayOfLine(line);
    const target = positional ?? modelDay.get(idx)!;
    nextRefs[target].push(idx);
  }

  const changed = parsed.days.some(
    (d, i) =>
      d.itemRefs.length !== nextRefs[i].length || d.itemRefs.some((r, j) => r !== nextRefs[i][j])
  );
  if (!changed) return parsed;

  return {
    ...parsed,
    days: parsed.days.map((d, i) => ({ ...d, itemRefs: nextRefs[i] })),
  };
}
