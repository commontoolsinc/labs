import { FabricBytes } from "./FabricBytes.ts";
import { FabricEpochDay } from "./FabricEpochDay.ts";
import { FabricEpochNsec } from "./FabricEpochNsec.ts";
import { FabricHash } from "./FabricHash.ts";
import { FabricKeyPair } from "./FabricKeyPair.ts";
import { FabricRegExp } from "./FabricRegExp.ts";
import { FabricUnavailable } from "./FabricUnavailable.ts";
import type { FabricPrimitiveClassesByName } from "./impl.ts";

/**
 * At least one instance of every concrete primitive class, keyed the way
 * `fabricPrimitiveClassesByName()` keys the classes. It is what a test that
 * ranges over the classes takes its values from, so that such a test holds no
 * table of its own to fall out of step. The first example of a class is the
 * one to reach for where a test wants one value per class.
 *
 * Its type is what holds it complete: a class with no entry here, or an entry
 * holding an instance of some other class, stops this module compiling.
 *
 * This has its own entry in the package's export map and no place in the
 * `fabric-primitives` barrel, so that loading the classes constructs none of
 * these.
 */
export const FABRIC_PRIMITIVE_EXAMPLES_FOR_TESTING_ONLY: {
  readonly [Name in keyof FabricPrimitiveClassesByName]: readonly [
    FabricPrimitiveClassesByName[Name]["prototype"],
    ...FabricPrimitiveClassesByName[Name]["prototype"][],
  ];
} = Object.freeze({
  FabricBytes: Object.freeze(
    [
      new FabricBytes(new Uint8Array([1, 2, 3])),
      new FabricBytes(new Uint8Array()),
    ] as const,
  ),

  FabricEpochDay: Object.freeze(
    [
      new FabricEpochDay(20_000n),
      new FabricEpochDay(0n),
      new FabricEpochDay(-1n),
    ] as const,
  ),

  FabricEpochNsec: Object.freeze(
    [
      new FabricEpochNsec(1_700n),
      new FabricEpochNsec(0n),
      new FabricEpochNsec(-1n),
    ] as const,
  ),

  FabricHash: Object.freeze(
    [new FabricHash(new Uint8Array(32), "fid1")] as const,
  ),

  // Pairs holding material, that being the arm constructible without a
  // `CryptoKey`. The algorithm name is arbitrary; a real one would mislead a
  // `grep`.
  FabricKeyPair: Object.freeze(
    [
      new FabricKeyPair(
        "ExampleAlgorithm",
        new Uint8Array([1, 2]),
        new Uint8Array([3, 4]),
      ),
    ] as const,
  ),

  FabricRegExp: Object.freeze(
    [
      new FabricRegExp(/a+/g),
      new FabricRegExp("es2025", "^x$", ""),
    ] as const,
  ),

  FabricUnavailable: Object.freeze(
    [
      new FabricUnavailable("error", "general", "boom"),
      new FabricUnavailable("pending"),
      new FabricUnavailable("syncing"),
    ] as const,
  ),
});
