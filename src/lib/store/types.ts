// Trip document + tripStore port — §4. One JSON document per trip, behind a
// slug. Anchors marked inline on stops; §2's persisted per-leg toggles live in
// legOverrides; user-facing settings (walkMax, driveOverheadMin) on the doc.

import type { LatLng } from "../maps/types";

export type TripStop = {
  id: string; // place_id (fixture or Google)
  name: string;
  location: LatLng;
  address?: string;
  durationMin: number;
  anchor?: { startMin: number };
  source?: string; // original pasted input
};

export type TripDay = {
  date: string;
  dayStartMin: number;
  dayEndMin: number;
  stops: TripStop[];
};

export type LegOverride = {
  dayIndex: number;
  fromId: string;
  toId: string;
  mode: "walk" | "drive";
};

export type TripDoc = {
  tripId: string;
  days: TripDay[];
  settings: { walkMax: number; driveOverheadMin: number };
  legOverrides: LegOverride[];
};

export interface TripStore {
  get(tripId: string): Promise<TripDoc | null>;
  put(doc: TripDoc): Promise<void>;
}
