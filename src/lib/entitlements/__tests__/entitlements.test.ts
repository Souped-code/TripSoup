// M1.1 — the gate-ability boundary. These tests pin the LOCKED shape: M3.5
// swaps the stub's SOURCE (Supabase rows + PAYWALL_MODE) and every assertion
// below about the interface must still hold unchanged.

import {
  ALL_CAPABILITIES,
  STUB_MAX_STOPS,
  createEntitlements,
  getEntitlements,
  type Capability,
} from "../entitlements";

describe("entitlements — LOCKED shape", () => {
  it("exposes exactly tier / has / maxStops / watermark", () => {
    const ent = getEntitlements();
    expect(typeof ent.tier).toBe("string");
    expect(typeof ent.has).toBe("function");
    expect(typeof ent.maxStops).toBe("number");
    expect(typeof ent.watermark).toBe("boolean");
  });

  it("pre-M3 stub is all-on, pass tier, 40 stops, no watermark", () => {
    const ent = getEntitlements();
    expect(ent.tier).toBe("pass");
    expect(ent.maxStops).toBe(STUB_MAX_STOPS);
    expect(STUB_MAX_STOPS).toBe(40);
    expect(ent.watermark).toBe(false);
    // Asserted over the exported list, not a restated literal, so a capability
    // added to the union can never silently ship "off" in the stub.
    for (const cap of ALL_CAPABILITIES) {
      expect({ cap, granted: ent.has(cap) }).toEqual({ cap, granted: true });
    }
  });

  it("reserves the future capability slots by name", () => {
    // M2/M4/M3.6 slot into these without reopening this boundary.
    expect(ALL_CAPABILITIES).toEqual(
      expect.arrayContaining<Capability>([
        "resolve.links",
        "interpret.names",
        "interpret.social",
        "suggest.crossDate",
        "export.hires",
      ])
    );
  });
});

describe("createEntitlements", () => {
  it("grants only the listed capabilities", () => {
    const ent = createEntitlements({
      tier: "free",
      capabilities: ["resolve.links"],
      maxStops: 8,
      watermark: true,
    });
    expect(ent.has("resolve.links")).toBe(true);
    expect(ent.has("interpret.names")).toBe(false);
    expect(ent.has("export.hires")).toBe(false);
    expect(ent.tier).toBe("free");
    expect(ent.maxStops).toBe(8);
    expect(ent.watermark).toBe(true);
  });

  it("snapshots the capability list — mutating the caller's array cannot re-grant mid-run", () => {
    // A pipeline run holds one Entitlements object across parse -> resolve;
    // what was entitled at the parse gate must still be entitled at the
    // resolve gate, no matter what the caller does to its own array.
    const caps: Capability[] = ["resolve.links"];
    const ent = createEntitlements({
      tier: "free",
      capabilities: caps,
      maxStops: 8,
      watermark: true,
    });
    caps.push("interpret.names");
    expect(ent.has("interpret.names")).toBe(false);
  });
});
