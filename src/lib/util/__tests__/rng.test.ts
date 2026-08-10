import { createRng } from "../rng";

describe("rng — seeded deterministic PRNG", () => {
  it("same seed produces identical sequence", () => {
    const rng1 = createRng(12345);
    const rng2 = createRng(12345);

    const seq1 = Array.from({ length: 20 }, () => rng1.next());
    const seq2 = Array.from({ length: 20 }, () => rng2.next());

    expect(seq1).toEqual(seq2);
  });

  it("different seeds produce different sequences", () => {
    const rng1 = createRng(12345);
    const rng2 = createRng(54321);

    const seq1 = Array.from({ length: 20 }, () => rng1.next());
    const seq2 = Array.from({ length: 20 }, () => rng2.next());

    expect(seq1).not.toEqual(seq2);
  });

  describe("int(maxExclusive)", () => {
    it("stays in range [0, maxExclusive) over 1000 draws with n=1", () => {
      const rng = createRng(999);
      for (let i = 0; i < 1000; i++) {
        const val = rng.int(1);
        expect(val).toBe(0);
      }
    });

    it("stays in range [0, maxExclusive) over 1000 draws with n=7", () => {
      const rng = createRng(999);
      for (let i = 0; i < 1000; i++) {
        const val = rng.int(7);
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThan(7);
      }
    });

    it("throws on non-positive maxExclusive", () => {
      const rng = createRng(42);
      expect(() => rng.int(0)).toThrow();
      expect(() => rng.int(-1)).toThrow();
      expect(() => rng.int(1.5)).toThrow();
    });
  });

  describe("pick(arr)", () => {
    it("covers all elements eventually when seeded deterministically", () => {
      const rng = createRng(777);
      const arr = ["a", "b", "c", "d"];
      const picked = new Set<string>();

      // With a deterministic seed, a reasonably long run should hit all elements.
      for (let i = 0; i < 100; i++) {
        picked.add(rng.pick(arr));
      }

      expect(picked.size).toBe(arr.length);
      expect(picked).toEqual(new Set(arr));
    });

    it("throws on empty array", () => {
      const rng = createRng(42);
      expect(() => rng.pick([])).toThrow();
    });

    it("same seed produces same pick sequence", () => {
      const rng1 = createRng(555);
      const rng2 = createRng(555);
      const arr = ["x", "y", "z"];

      const picks1 = Array.from({ length: 10 }, () => rng1.pick(arr));
      const picks2 = Array.from({ length: 10 }, () => rng2.pick(arr));

      expect(picks1).toEqual(picks2);
    });
  });

  describe("shuffle(arr)", () => {
    it("does not mutate input array", () => {
      const rng = createRng(42);
      const original = [1, 2, 3, 4, 5];
      const copy = [...original];

      rng.shuffle(original);

      expect(original).toEqual(copy);
    });

    it("returns a permutation of the input", () => {
      const rng = createRng(42);
      const input = [1, 2, 3, 4, 5];
      const shuffled = rng.shuffle(input);

      // Same elements, possibly different order.
      expect(shuffled.sort((a, b) => a - b)).toEqual(input.sort((a, b) => a - b));
    });

    it("same seed produces same shuffle", () => {
      const rng1 = createRng(333);
      const rng2 = createRng(333);
      const input = [1, 2, 3, 4, 5];

      const shuffled1 = rng1.shuffle(input);
      const shuffled2 = rng2.shuffle(input);

      expect(shuffled1).toEqual(shuffled2);
    });

    it("different seeds produce different shuffles", () => {
      const rng1 = createRng(111);
      const rng2 = createRng(222);
      const input = [1, 2, 3, 4, 5];

      const shuffled1 = rng1.shuffle(input);
      const shuffled2 = rng2.shuffle(input);

      // Unlikely to be identical (cryptographically impossible to be guaranteed).
      expect(shuffled1).not.toEqual(shuffled2);
    });

    it("handles single-element and two-element arrays", () => {
      const rng = createRng(42);

      const single = rng.shuffle([42]);
      expect(single).toEqual([42]);

      const pair = rng.shuffle([1, 2]);
      expect(pair.sort()).toEqual([1, 2]);
    });
  });
});
