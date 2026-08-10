// File-backed tripStore — development and all tests (§4).

import { mkdir, readFile, writeFile } from "fs/promises";
import * as path from "path";
import { computeSolveHash } from "../plan/solveProjection";
import type { TripDoc, TripStore } from "./types";

export function createFileStore(dir: string): TripStore {
  const fileOf = (tripId: string) => {
    if (!/^[a-z0-9-]+$/i.test(tripId)) throw new Error(`invalid trip id: ${tripId}`);
    return path.join(dir, `${tripId}.json`);
  };
  return {
    async get(tripId) {
      try {
        return JSON.parse(await readFile(fileOf(tripId), "utf8")) as TripDoc;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async put(doc) {
      // E4 dev/test loud-failure invariant (NOT applied to kvStore/prod, which
      // stays permissive — readPlanned self-heals there instead): a stamped
      // plan whose solveHash doesn't match the doc it's attached to means
      // something wrote a plan without going through planStore's chokepoint
      // (savePlanned/persistPlanned). That's a bug, and in dev/test it must
      // fail loudly right here rather than silently serving a stale plan.
      // computeSolveHash is imported from ../plan/solveProjection, NOT from
      // ../planStore, to avoid a cycle: planStore.ts imports ../config, which
      // constructs this very file.
      if (doc.plan && doc.plan.solveHash !== computeSolveHash(doc)) {
        throw new Error(
          `fileStore.put: doc.plan.solveHash is stale for trip "${doc.tripId}" — ` +
            "plans must be written via planStore.savePlanned/persistPlanned, not put() directly."
        );
      }
      await mkdir(dir, { recursive: true });
      await writeFile(fileOf(doc.tripId), JSON.stringify(doc, null, 2), "utf8");
    },
  };
}
