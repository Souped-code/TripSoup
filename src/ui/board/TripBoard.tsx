"use client";

// Trip board — §5 P4: days, stops, anchor lock/unlock, durations, add-stops
// paste box, optimize action, result view, settings (walkMax, driveOverhead),
// infeasibility and failure states rendered. All Google contact stays server-side.
//
// D2.3 (T2): relocated from app/trip/[id]/page.tsx to /debug/trip/[id]/page.tsx
// (old board -> /debug, per the master plan). Split out as its own client
// component so the route's page.tsx can stay a Server Component and gate on
// DEBUG_BOARD reliably — process.env.DEBUG_BOARD isn't a NEXT_PUBLIC_ var, so
// it isn't available in the browser bundle a "use client" page would ship
// (same reasoning as app/debug/pipeline/page.tsx + PipelineDebug).

import { use, useCallback, useEffect, useState } from "react";
import type { TripDoc, TripStop } from "@/lib/store/types";
import type { DayPlan } from "@/lib/schedule/types";
import type { Failure } from "../../../resolvePlaces";
import { PlanView } from "@/ui/PlanView";
import { fmtTime, parseTime } from "@/ui/time";

export function TripBoard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [doc, setDoc] = useState<TripDoc | null>(null);
  const [plans, setPlans] = useState<Record<number, DayPlan>>({});
  const [failures, setFailures] = useState<Record<number, Failure[]>>({});
  const [pasteText, setPasteText] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/trips/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`trip not found`))))
      .then(setDoc)
      .catch((e) => setError(String(e.message ?? e)));
  }, [id]);

  const save = useCallback(
    async (next: TripDoc) => {
      setDoc(next);
      setPlans({}); // stale after any edit
      await fetch(`/api/trips/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
    },
    [id]
  );

  async function addStops(dayIndex: number) {
    if (!doc) return;
    setBusy(true);
    setFailures((f) => ({ ...f, [dayIndex]: [] }));
    try {
      const inputs = (pasteText[dayIndex] ?? "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await fetch(`/api/trips/${id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputs }),
      });
      const { stops, failures: fails } = (await res.json()) as {
        stops: (TripStop & { openingHours?: unknown })[];
        failures: Failure[];
      };
      const day = doc.days[dayIndex];
      const existing = new Set(day.stops.map((s) => s.id));
      const dupes: Failure[] = [];
      const fresh: TripStop[] = [];
      for (const s of stops) {
        if (existing.has(s.id) || fresh.some((f) => f.id === s.id)) {
          dupes.push({ source: s.source ?? s.name, reason: "already on this day" });
        } else {
          fresh.push({
            id: s.id,
            name: s.name,
            location: s.location,
            address: s.address,
            durationMin: 60,
            source: s.source,
          });
        }
      }
      setFailures((f) => ({ ...f, [dayIndex]: [...fails, ...dupes] }));
      const days = doc.days.map((d, i) =>
        i === dayIndex ? { ...d, stops: [...d.stops, ...fresh] } : d
      );
      await save({ ...doc, days });
      setPasteText((p) => ({ ...p, [dayIndex]: "" }));
    } finally {
      setBusy(false);
    }
  }

  function updateStop(dayIndex: number, stopId: string, patch: Partial<TripStop>) {
    if (!doc) return;
    const days = doc.days.map((d, i) =>
      i === dayIndex
        ? { ...d, stops: d.stops.map((s) => (s.id === stopId ? { ...s, ...patch } : s)) }
        : d
    );
    void save({ ...doc, days });
  }

  function removeStop(dayIndex: number, stopId: string) {
    if (!doc) return;
    const days = doc.days.map((d, i) =>
      i === dayIndex ? { ...d, stops: d.stops.filter((s) => s.id !== stopId) } : d
    );
    const legOverrides = doc.legOverrides.filter(
      (o) => o.dayIndex !== dayIndex || (o.fromId !== stopId && o.toId !== stopId)
    );
    void save({ ...doc, days, legOverrides });
  }

  async function optimizeDay(dayIndex: number) {
    setBusy(true);
    try {
      const res = await fetch(`/api/trips/${id}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dayIndex }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? `plan failed: ${res.status}`);
      const plan = (await res.json()) as DayPlan;
      setPlans((p) => ({ ...p, [dayIndex]: plan }));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleLeg(dayIndex: number, fromId: string, toId: string, mode: "walk" | "drive") {
    if (!doc || busy) return; // serialize: two rapid toggles must not race the doc
    setBusy(true);
    try {
      const legOverrides = [
        ...doc.legOverrides.filter(
          (o) => !(o.dayIndex === dayIndex && o.fromId === fromId && o.toId === toId)
        ),
        { dayIndex, fromId, toId, mode },
      ];
      // §2: the toggle persists, and re-times without re-ordering (server-side).
      const next = { ...doc, legOverrides };
      setDoc(next);
      await fetch(`/api/trips/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
    } finally {
      setBusy(false);
    }
    await optimizeDay(dayIndex);
  }

  function addDay() {
    if (!doc) return;
    const last = doc.days[doc.days.length - 1];
    const nextDate = new Date(new Date(last.date).getTime() + 86_400_000)
      .toISOString()
      .slice(0, 10);
    void save({
      ...doc,
      days: [...doc.days, { date: nextDate, dayStartMin: last.dayStartMin, dayEndMin: last.dayEndMin, stops: [] }],
    });
  }

  if (error) return <main data-testid="error">{error}</main>;
  if (!doc) return <main className="muted">Loading…</main>;

  return (
    <main>
      <h1>Trip board</h1>
      <div className="row">
        <span className="muted">
          share link: <a href={`/share/${doc.tripId}`} data-testid="share-link">/share/{doc.tripId}</a>
        </span>
      </div>

      <div className="card" data-testid="settings">
        <h2>Settings</h2>
        <div className="row">
          <label>
            max walk (min){" "}
            <input
              data-testid="walkmax-input"
              type="number"
              min={0}
              style={{ width: 70 }}
              value={doc.settings.walkMax}
              onChange={(e) => {
                if (e.target.value === "") return; // don't persist a cleared field as 0
                save({ ...doc, settings: { ...doc.settings, walkMax: Number(e.target.value) } });
              }}
            />
          </label>
          <label>
            drive overhead (min){" "}
            <input
              data-testid="overhead-input"
              type="number"
              min={0}
              style={{ width: 70 }}
              value={doc.settings.driveOverheadMin}
              onChange={(e) => {
                if (e.target.value === "") return;
                save({
                  ...doc,
                  settings: { ...doc.settings, driveOverheadMin: Number(e.target.value) },
                });
              }}
            />
          </label>
        </div>
      </div>

      {doc.days.map((day, dayIndex) => (
        <section className="card" key={dayIndex} data-testid={`day-${dayIndex}`}>
          <h2>
            Day {dayIndex + 1} · {day.date} · {fmtTime(day.dayStartMin)}–{fmtTime(day.dayEndMin)}
          </h2>

          <div data-testid="stop-list">
            {day.stops.map((stop) => (
              <div className="stop-row row" key={stop.id} data-testid={`stop-${stop.id}`}>
                <strong>{stop.name}</strong>
                <label className="muted">
                  visit{" "}
                  <input
                    type="number"
                    min={0}
                    style={{ width: 64 }}
                    value={stop.durationMin}
                    data-testid={`duration-${stop.id}`}
                    onChange={(e) => {
                      if (e.target.value === "") return;
                      updateStop(dayIndex, stop.id, { durationMin: Number(e.target.value) });
                    }}
                  />{" "}
                  min
                </label>
                <label className="muted">
                  <input
                    type="checkbox"
                    checked={!!stop.anchor}
                    data-testid={`anchor-toggle-${stop.id}`}
                    onChange={(e) =>
                      updateStop(dayIndex, stop.id, {
                        anchor: e.target.checked ? { startMin: 12 * 60 } : undefined,
                      })
                    }
                  />{" "}
                  booked at
                </label>
                {stop.anchor && (
                  <input
                    style={{ width: 76 }}
                    defaultValue={fmtTime(stop.anchor.startMin)}
                    data-testid={`anchor-time-${stop.id}`}
                    onBlur={(e) => {
                      const min = parseTime(e.target.value);
                      if (min !== null) {
                        updateStop(dayIndex, stop.id, { anchor: { startMin: min } });
                      } else {
                        e.target.value = fmtTime(stop.anchor!.startMin); // revert invalid input
                      }
                    }}
                  />
                )}
                <button data-testid={`remove-${stop.id}`} onClick={() => removeStop(dayIndex, stop.id)}>
                  remove
                </button>
              </div>
            ))}
            {day.stops.length === 0 && <div className="muted">No stops yet — paste below.</div>}
          </div>

          <div style={{ marginTop: 10 }}>
            <textarea
              rows={3}
              placeholder="Paste Google Maps links or place names, one per line"
              value={pasteText[dayIndex] ?? ""}
              data-testid="paste-box"
              onChange={(e) => setPasteText((p) => ({ ...p, [dayIndex]: e.target.value }))}
            />
            <div className="row" style={{ marginTop: 6 }}>
              <button
                onClick={() => addStops(dayIndex)}
                disabled={busy || (pasteText[dayIndex] ?? "").trim() === ""}
                data-testid="add-stops"
              >
                Add stops
              </button>
              <button
                className="primary"
                onClick={() => optimizeDay(dayIndex)}
                disabled={busy || day.stops.length === 0}
                data-testid="optimize"
              >
                Optimize day
              </button>
            </div>
          </div>

          {(failures[dayIndex]?.length ?? 0) > 0 && (
            <div className="failures" style={{ marginTop: 8 }} data-testid="resolve-failures">
              {failures[dayIndex].map((f, i) => (
                <div key={i}>
                  <code>{f.source}</code> — {f.reason}
                </div>
              ))}
            </div>
          )}

          {plans[dayIndex] && (
            <div style={{ marginTop: 12 }}>
              <PlanView
                plan={plans[dayIndex]}
                stopNames={Object.fromEntries(day.stops.map((s) => [s.id, s.name]))}
                onToggleLeg={(fromId, toId, mode) => toggleLeg(dayIndex, fromId, toId, mode)}
              />
            </div>
          )}
        </section>
      ))}

      <button onClick={addDay} disabled={busy} data-testid="add-day">
        Add day
      </button>
    </main>
  );
}
