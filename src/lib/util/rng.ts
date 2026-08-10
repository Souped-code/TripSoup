// Seeded deterministic PRNG for solver/spike reproducibility.
// Solver runs must be reproducible from a stored seed (plan persistence stores engine.seed),
// and Math.random is banned in engine code.
//
// Implementation: mulberry32, a 32-bit xorshift-derived algorithm that folds XOR with modular
// multiplication to achieve good avalanche. Period is 2^32 for most seeds.

export interface Rng {
  next(): number; // Returns float in [0, 1)
  int(maxExclusive: number): number; // Returns integer in [0, maxExclusive)
  pick<T>(arr: readonly T[]): T; // Uniformly chosen element (throw on empty)
  shuffle<T>(arr: readonly T[]): T[]; // Fisher-Yates, returns NEW array
}

export function createRng(seed: number): Rng {
  // Mulberry32: fold XOR with modular multiplication to avoid seed pathologies.
  let state = seed | 0; // Coerce to 32-bit signed int
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    // XOR shift.
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000; // Normalize to [0, 1)
  };

  return {
    next,
    int(maxExclusive: number): number {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
        throw new Error(`int(maxExclusive) requires positive integer, got ${maxExclusive}`);
      }
      return Math.floor(next() * maxExclusive);
    },
    pick<T>(arr: readonly T[]): T {
      if (arr.length === 0) {
        throw new Error("pick: cannot pick from empty array");
      }
      return arr[this.int(arr.length)];
    },
    shuffle<T>(arr: readonly T[]): T[] {
      // Fisher-Yates on a copy; does not mutate input.
      const copy = [...arr];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = this.int(i + 1);
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    },
  };
}
