// Public-transport legs (Singapore): the step list a rider follows, and the
// credit the LTA data licence requires wherever these journeys show.
// Type-only imports — the 547 KB network never reaches the client bundle.

import type { Journey, JourneyStep } from "@/lib/transit/sg/router";
import type { PlanLeg } from "@/lib/schedule/types";
import { formatDuration } from "@/lib/util/duration";

/** Does any leg of this plan (incl. the hotel lead/back) carry a journey? */
export function planHasTransit(legs: PlanLeg[], baseLegs?: { lead: PlanLeg; back: PlanLeg }): boolean {
  return legs.some((l) => l.transit) || !!baseLegs?.lead.transit || !!baseLegs?.back.transit;
}

/** "MRT" when the journey rides a train, else "bus"; the plain mode otherwise. */
export function legModeLabel(leg: PlanLeg): string {
  if (leg.mode !== "transit" || !leg.transit) return leg.mode;
  return leg.transit.steps.some((s) => s.kind === "mrt") ? "MRT" : "bus";
}

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span className="reveal-transit__badge" style={{ background: color }}>
      {text}
    </span>
  );
}

function changeNote(walkMin: number): string {
  if (walkMin <= 1) return " (often straight across the platform)";
  if (walkMin >= 6) return " (long walk)";
  return "";
}

function Step({ step }: { step: JourneyStep }) {
  switch (step.kind) {
    case "walk":
      return <>Walk {formatDuration(step.minutes)} to {step.to}</>;
    case "mrt":
      return (
        <>
          <Badge text={step.badge} color={step.color} /> {step.from} → {step.to} ·{" "}
          {step.towards ? `towards ${step.towards}` : `next stop ${step.nextStop}`} · {step.stops}{" "}
          {step.stops === 1 ? "stop" : "stops"} · {formatDuration(step.minutes)}
        </>
      );
    case "change":
      return (
        <>
          Change to the {step.toLineName} at {step.at} — {formatDuration(step.walkMin)} between platforms
          {changeNote(step.walkMin)}
        </>
      );
    case "bus":
      return (
        <>
          <Badge text={step.service} color="var(--ink)" />{" "}
          {step.loopVia ? `loop service via ${step.loopVia}` : `towards ${step.towards}`} · board at {step.board.name} (
          {step.board.code}), {step.board.road} · {step.stops} {step.stops === 1 ? "stop" : "stops"} · get off at{" "}
          {step.alight.name} ({step.alight.code}) · {formatDuration(step.minutes)}
        </>
      );
  }
}

export function TransitSteps({ journey, testId }: { journey: Journey; testId?: string }) {
  return (
    <ol className="reveal-transit" data-testid={testId}>
      {journey.steps.map((step, i) => (
        <li key={i} data-kind={step.kind}>
          <Step step={step} />
        </li>
      ))}
    </ol>
  );
}

export function TransitCredit() {
  return (
    <p className="reveal-transit__credit">
      Contains information from LTA DataMall accessed on 1 October 2026 from https://datamall.lta.gov.sg, made
      available under the terms of the Singapore Open Data Licence version 1.0. Station locations © OpenStreetMap
      contributors. Public-transport times are estimates.
    </p>
  );
}
