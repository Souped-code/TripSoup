// Canonical-JSON hashing for plan staleness detection.
// TripDoc.plan.solveHash: two docs with the same solve-relevant content MUST hash
// identically regardless of key insertion order. Feeds plan staleness detection.
//
// Rejects undefined, functions, symbols, bigint, NaN, Infinity, and cycles — these
// are lossy and turn staleness detection into a bug factory.

import { createHash } from "crypto";

export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();

  const stringify = (val: unknown): string => {
    // Guard against undefined early.
    if (val === undefined) {
      throw new Error("canonicalJson: undefined is not serializable");
    }
    if (val === null) return "null";

    const type = typeof val;
    if (type === "boolean" || type === "number" || type === "string") {
      // JSON semantics for primitives.
      if (type === "number") {
        if (!Number.isFinite(val as number)) {
          throw new Error(
            `canonicalJson: ${val} is not finite (NaN and Infinity are not serializable)`
          );
        }
      }
      return JSON.stringify(val);
    }

    if (type === "function" || type === "symbol") {
      throw new Error(`canonicalJson: ${type} is not serializable`);
    }

    if (type === "bigint") {
      throw new Error("canonicalJson: bigint is not serializable");
    }

    // Objects and arrays.
    if (type === "object") {
      // `seen` tracks the CURRENT PATH only (added before recursing, removed
      // after) — an object on its own ancestor chain is a genuine cycle. A
      // Set held for the whole walk would also reject shared references (the
      // same object appearing under two keys), which are legal, acyclic, and
      // must hash by value like any other content.
      if (seen.has(val as object)) {
        throw new Error("canonicalJson: circular reference detected");
      }
      seen.add(val as object);

      let out: string;
      if (Array.isArray(val)) {
        // Arrays: keep order, stringify each element.
        out = "[" + val.map((item) => stringify(item)).join(",") + "]";
      } else {
        // Plain objects: sort keys lexicographically at every depth.
        const keys = Object.keys(val as Record<string, unknown>).sort();
        out =
          "{" +
          keys.map((k) => `${JSON.stringify(k)}:${stringify((val as any)[k])}`).join(",") +
          "}";
      }

      seen.delete(val as object);
      return out;
    }

    // Defensive: should not reach here.
    throw new Error(`canonicalJson: unsupported type ${type}`);
  };

  return stringify(value);
}

export function stableHash(value: unknown): string {
  const json = canonicalJson(value);
  return createHash("sha256").update(json, "utf8").digest("hex");
}
