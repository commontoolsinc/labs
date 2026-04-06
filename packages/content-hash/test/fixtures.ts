/**
 * Test fixtures for hashing.
 */

interface NumbersHashTuple {
  numbers: readonly number[];
  sha256: string;
};

export interface ContentHashTuple extends NumbersHashTuple {
  bytes: Uint8Array;
};

const NUMBERS_FIXTURES: readonly NumbersHashTuple[] = [
  {
    numbers: [],
    sha256: "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
  },
] as const;

export const FIXTURES: readonly ContentHashTuple[] = Object.freeze(
  NUMBERS_FIXTURES.map(
    (one: NumbersHashTuple): ContentHashTuple => {
      return {
        bytes: new Uint8Array(one.numbers),
        ...one,
      };
    }));
