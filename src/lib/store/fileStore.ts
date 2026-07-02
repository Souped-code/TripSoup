// File-backed tripStore — development and all tests (§4).

import { mkdir, readFile, writeFile } from "fs/promises";
import * as path from "path";
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
      await mkdir(dir, { recursive: true });
      await writeFile(fileOf(doc.tripId), JSON.stringify(doc, null, 2), "utf8");
    },
  };
}
