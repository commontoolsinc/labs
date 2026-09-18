/**
 * What this package offers to tests alone: examples of every concrete
 * `FabricPrimitive` and `FabricInstance` class, for a test that ranges over
 * the classes to take its values from, so that it holds no table of its own
 * to fall out of step. Each table's type is what holds it complete: a class
 * with no entry, or an entry of some other class, stops this module compiling.
 *
 * This has its own entry in the package's export map and no place in any
 * barrel, so that loading the classes constructs none of it.
 */

import { ProblematicValue } from "@/codec-common/ProblematicValue.ts";
import { UnknownValue } from "@/codec-common/UnknownValue.ts";
import { FabricError } from "@/fabric-instances/FabricError.ts";
import { FabricLink } from "@/fabric-instances/FabricLink.ts";
import { FabricMap } from "@/fabric-instances/FabricMap.ts";
import { FabricSet } from "@/fabric-instances/FabricSet.ts";
import type { FabricInstanceClassesByName } from "@/fabric-instances/impl.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import { FabricEpochDay } from "@/fabric-primitives/FabricEpochDay.ts";
import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";
import { FabricHash } from "@/fabric-primitives/FabricHash.ts";
import { FabricKeyPair } from "@/fabric-primitives/FabricKeyPair.ts";
import { FabricRegExp } from "@/fabric-primitives/FabricRegExp.ts";
import { FabricUnavailable } from "@/fabric-primitives/FabricUnavailable.ts";
import type { FabricPrimitiveClassesByName } from "@/fabric-primitives/impl.ts";

/**
 * At least one instance of every concrete primitive class, keyed the way
 * `fabricPrimitiveClassesByName()` keys the classes. The first example of a
 * class is the one to reach for where a test wants one value per class. A
 * primitive is immutable, so these are shared.
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

/**
 * At least one maker of instances of every concrete instance class, keyed the
 * way `fabricInstanceClassesByName()` keys the classes. The first maker of a
 * class is the one to reach for where a test wants one value per class.
 *
 * Makers and not instances: an instance can be mutable, and an operation under
 * test may freeze the one it is given in place, so each call returns a new
 * instance equal to every other the same maker returns.
 */
export const FABRIC_INSTANCE_EXAMPLE_MAKERS_FOR_TESTING_ONLY: {
  readonly [Name in keyof FabricInstanceClassesByName]: readonly [
    () => FabricInstanceClassesByName[Name]["prototype"],
    ...(() => FabricInstanceClassesByName[Name]["prototype"])[],
  ];
} = Object.freeze({
  FabricError: Object.freeze(
    [
      () =>
        new FabricError({
          type: "Error",
          name: "Error",
          message: "boom",
          stack: undefined,
          cause: undefined,
        }),
      () =>
        new FabricError({
          type: "TypeError",
          name: "TypeError",
          message: "not a donut",
          stack: undefined,
          cause: undefined,
        }),
    ] as const,
  ),

  FabricLink: Object.freeze(
    [() => new FabricLink({ id: "of:fid1:aaa" })] as const,
  ),

  FabricMap: Object.freeze(
    [
      () => new FabricMap(new Map([["a", 1]])),
      () => new FabricMap(new Map()),
    ] as const,
  ),

  FabricSet: Object.freeze(
    [
      () => new FabricSet(new Set([1, 2])),
      () => new FabricSet(new Set()),
    ] as const,
  ),

  ProblematicValue: Object.freeze(
    [() => new ProblematicValue("Example@1", "state-data", "boom")] as const,
  ),

  UnknownValue: Object.freeze(
    [() => new UnknownValue("Example@1", "state-data")] as const,
  ),
});
