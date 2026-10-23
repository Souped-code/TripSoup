import { fmtTime } from "../time";

describe("fmtTime", () => {
  it("rounds to the nearest minute before splitting hours and minutes", () => {
    // Real travel minutes are fractional (Google seconds / 60).
    expect(fmtTime(599.6)).toBe("10:00");
    expect(fmtTime(1021.33)).toBe("17:01");
    expect(fmtTime(1439.7)).toBe("00:00");
  });

  it("wraps past midnight", () => {
    expect(fmtTime(25 * 60 + 10)).toBe("01:10");
  });
});
