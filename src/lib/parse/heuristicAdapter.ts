// Heuristic adapter — the fallback provider AND the only adapter jest
// exercises directly (mirrors maps/fixtureAdapter.ts: no network, no key,
// fully deterministic, safe for unattended CI).
//
// Strategy: classify every line of the pasted text as a day marker, a group
// marker, or plain content; pull URLs out of content lines verbatim; pair
// non-URL content with its nearest adjacent URL as that link's label; and
// flag time-bearing lines as likely schedule anchors. None of this is a
// language model — it is regexes over line adjacency, which is why results
// must stay 100% reproducible for the golden tests in __tests__/.

import type { ParsedItinerary, ParsedItem, ParseProvider } from "./types";

// Extracted verbatim — never trim/rewrite the matched substring itself.
const URL_REGEX = /https?:\/\/\S+/;

const TIME_REGEX = /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i;

const DAY_LINE_REGEX =
  /^(day\s+\d+|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan\w*\s+\d{1,2}|feb\w*\s+\d{1,2}|mar\w*\s+\d{1,2}|apr\w*\s+\d{1,2}|may\s+\d{1,2}|jun\w*\s+\d{1,2}|jul\w*\s+\d{1,2}|aug\w*\s+\d{1,2}|sep\w*\s+\d{1,2}|oct\w*\s+\d{1,2}|nov\w*\s+\d{1,2}|dec\w*\s+\d{1,2}|\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?)\s*:?$/i;

const GROUP_LINE_REGEX = /^(group\s+\S+|team\s+\S+)$/i;

const FIRST_REGEX = /\bfirst\b/i;

type LineType = "blank" | "day" | "group" | "content";

type LineRecord = {
  idx: number;
  text: string; // trimmed
  type: LineType;
  urlMatch: string | null; // verbatim URL substring, if any
};

function classifyLines(text: string): LineRecord[] {
  const rawLines = text.split(/\r?\n/);
  return rawLines.map((raw, idx) => {
    const trimmed = raw.trim();
    let type: LineType;
    if (trimmed === "") type = "blank";
    else if (DAY_LINE_REGEX.test(trimmed)) type = "day";
    else if (GROUP_LINE_REGEX.test(trimmed)) type = "group";
    else type = "content";
    const urlMatch = type === "content" ? trimmed.match(URL_REGEX)?.[0] ?? null : null;
    return { idx, text: trimmed, type, urlMatch };
  });
}

// Strips leftover connector punctuation left behind once the URL substring
// is removed from a same-line label candidate, e.g. "Grand Hotel -" -> "Grand Hotel".
function stripConnectors(s: string): string {
  return s.replace(/^[-:@\s]+|[-:@\s]+$/g, "");
}

// Pairs each URL line with an adjacent label (same line first, then the
// line immediately above, then immediately below). Marks whichever line
// supplied the label as "consumed" so it doesn't also become its own
// standalone label item.
function pairLabels(lines: LineRecord[]): { labelFor: Map<number, string>; consumed: Set<number> } {
  const labelFor = new Map<number, string>();
  const consumed = new Set<number>();

  const isFreeContent = (rec: LineRecord | undefined): rec is LineRecord =>
    !!rec && rec.type === "content" && !rec.urlMatch && !consumed.has(rec.idx);

  for (const line of lines) {
    if (line.type !== "content" || !line.urlMatch) continue;

    const sameLineLabel = stripConnectors(line.text.replace(line.urlMatch, ""));
    if (sameLineLabel) {
      labelFor.set(line.idx, sameLineLabel);
      continue;
    }

    const above = lines[line.idx - 1];
    if (isFreeContent(above)) {
      labelFor.set(line.idx, above.text);
      consumed.add(above.idx);
      continue;
    }

    const below = lines[line.idx + 1];
    if (isFreeContent(below)) {
      labelFor.set(line.idx, below.text);
      consumed.add(below.idx);
    }
  }

  return { labelFor, consumed };
}

function detectTime(...texts: (string | undefined)[]): { timeHint?: string; anchorLikely: boolean; anchorReason?: string } {
  for (const t of texts) {
    if (!t) continue;
    const match = t.match(TIME_REGEX);
    if (match) {
      return {
        timeHint: match[0],
        anchorLikely: true,
        anchorReason: `time hint "${match[0]}" implies a fixed-time schedule anchor`,
      };
    }
  }
  return { anchorLikely: false };
}

export function createHeuristicAdapter(): ParseProvider {
  return {
    async parse(text: string): Promise<ParsedItinerary> {
      const lines = classifyLines(text);
      const { labelFor, consumed } = pairLabels(lines);

      const items: ParsedItem[] = [];
      const days: ParsedItinerary["days"] = [];
      const splitGroupIndices = new Map<string, number[]>();

      let currentDayIdx: number | null = null;
      let currentGroup: string | null = null;

      const ensureDay = (): void => {
        if (currentDayIdx === null) {
          days.push({ itemRefs: [] });
          currentDayIdx = days.length - 1;
        }
      };

      for (const line of lines) {
        if (line.type === "blank") continue;

        if (line.type === "day") {
          days.push({ dateHint: line.text, itemRefs: [] });
          currentDayIdx = days.length - 1;
          continue;
        }

        if (line.type === "group") {
          currentGroup = line.text;
          if (!splitGroupIndices.has(currentGroup)) splitGroupIndices.set(currentGroup, []);
          continue;
        }

        // content line
        if (line.urlMatch) {
          const label = labelFor.get(line.idx);
          const time = detectTime(label, line.text);
          ensureDay();
          const item: ParsedItem = {
            kind: "link",
            raw: line.text,
            url: line.urlMatch,
            ...(label ? { label } : {}),
            ...(currentDayIdx !== null && days[currentDayIdx].dateHint
              ? { dateHint: days[currentDayIdx].dateHint }
              : {}),
            ...time,
            ...(currentGroup ? { groupHint: currentGroup } : {}),
          };
          const itemIdx = items.push(item) - 1;
          days[currentDayIdx!].itemRefs.push(itemIdx);
          if (currentGroup) splitGroupIndices.get(currentGroup)!.push(itemIdx);
          continue;
        }

        if (consumed.has(line.idx)) continue; // already used as a link's label

        // standalone label item
        const time = detectTime(line.text);
        ensureDay();
        const item: ParsedItem = {
          kind: "label",
          raw: line.text,
          label: line.text,
          ...(currentDayIdx !== null && days[currentDayIdx].dateHint
            ? { dateHint: days[currentDayIdx].dateHint }
            : {}),
          ...time,
          ...(currentGroup ? { groupHint: currentGroup } : {}),
        };
        const itemIdx = items.push(item) - 1;
        days[currentDayIdx!].itemRefs.push(itemIdx);
        if (currentGroup) splitGroupIndices.get(currentGroup)!.push(itemIdx);
      }

      // Second pass: "drop bags first"-style lines get an orderConstraint
      // against whichever item immediately follows them in document order.
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.orderConstraint) continue;
        const scanText = [item.raw, item.label].filter(Boolean).join(" ");
        if (FIRST_REGEX.test(scanText)) {
          const next = items[i + 1];
          item.orderConstraint = {
            ...(next ? { before: [next.raw] } : {}),
            reason: item.raw,
          };
        }
      }

      const splitGroups = Array.from(splitGroupIndices.entries())
        .filter(([, refs]) => refs.length > 0)
        .map(([name, itemRefs]) => ({ name, itemRefs }));

      return {
        items,
        days: days.filter((d) => d.itemRefs.length > 0),
        splitGroups,
      };
    },
  };
}
