// E7 — the $0 constraint compiler, the parse-side fixtureParseAdapter's twin:
// deterministic keyword rules so tests and e2e exercise the whole persisted-
// constraint path (compile -> tether -> patch -> chips -> solve) without an
// API key. Each rule emits the EXACT matched span as evidence, which is what
// the orchestrator's tether check requires of the live model too — so the
// fixture proves the contract, not a lookalike.

import type {
  CompileContext,
  ConstraintCompileProvider,
  ConstraintEmission,
  ConstraintEmissions,
} from "./types";

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** The context stop whose name appears in `line`, longest name first (the
 * fixtureParseAdapter's shadowing rule). */
function stopIn(line: string, context: CompileContext): string | null {
  const hay = norm(line);
  const names = [...context.stops].sort((a, b) => b.name.length - a.name.length);
  for (const s of names) {
    if (hay.includes(norm(s.name))) return s.name;
  }
  return null;
}

function parseClock(h: string, m: string | undefined, ampm: string | undefined): number {
  let hour = Number.parseInt(h, 10);
  const minute = m === undefined ? 0 : Number.parseInt(m, 10);
  if (ampm?.toLowerCase() === "pm" && hour < 12) hour += 12;
  if (ampm?.toLowerCase() === "am" && hour === 12) hour = 0;
  return hour * 60 + minute;
}

const PACE_RELAXED = /walks slow|keep it chill|keep the days? chill|easy pace|not too packed|take it slow/i;
const PACE_PACKED = /pack (?:it all|everything) in|as much as possible|full send/i;
const SUNSET = /sunset/i;
const MORNING = /in the morning|morning visit/i;
const LAST_ENTRY = /last entry (?:is )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
const MUST_SEE = /must[- ]see|can'?t miss|have to (?:see|do|go)/i;

export function createFixtureConstraintsAdapter(): ConstraintCompileProvider {
  return {
    async compile(text: string, context: CompileContext): Promise<ConstraintEmissions> {
      const constraints: ConstraintEmission[] = [];
      const seen = new Set<string>();
      const push = (e: ConstraintEmission): void => {
        const key = JSON.stringify(e);
        if (!seen.has(key)) {
          seen.add(key);
          constraints.push(e);
        }
      };

      for (const line of text.split(/\r?\n/)) {
        const relaxed = line.match(PACE_RELAXED);
        if (relaxed) push({ kind: "pace", preset: "relaxed", evidence: relaxed[0] });
        const packed = line.match(PACE_PACKED);
        if (packed) push({ kind: "pace", preset: "packed", evidence: packed[0] });

        const name = stopIn(line, context);
        if (!name) continue;

        const sunset = line.match(SUNSET);
        if (sunset) {
          push({ kind: "stopWindow", stopName: name, startMin: 1050, endMin: 1170, evidence: sunset[0] });
        }
        const morning = line.match(MORNING);
        if (morning) {
          push({ kind: "stopWindow", stopName: name, startMin: 540, endMin: 720, evidence: morning[0] });
        }
        const lastEntry = line.match(LAST_ENTRY);
        if (lastEntry) {
          push({
            kind: "lastEntry",
            stopName: name,
            lastEntryMin: parseClock(lastEntry[1], lastEntry[2] ?? undefined, lastEntry[3] ?? undefined),
            evidence: lastEntry[0],
          });
        }
        const must = line.match(MUST_SEE);
        if (must) push({ kind: "priority", stopName: name, priority: "must", evidence: must[0] });
      }

      return { constraints };
    },
  };
}
