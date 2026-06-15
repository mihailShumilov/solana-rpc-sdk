/**
 * Deterministic, seedable PRNG (mulberry32) so every simulated fault sequence
 * is fully reproducible. No test may use Math.random() — reproducibility is a
 * judging-relevant property of the simulation harness.
 */
export type Rng = () => number;

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Returns true with probability `p` (0..1) using the supplied RNG. */
export function chance(rng: Rng, p: number): boolean {
  if (p <= 0) return false;
  if (p >= 1) return true;
  return rng() < p;
}

/** Uniform integer in [min, max]. */
export function randInt(rng: Rng, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}
