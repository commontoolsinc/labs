import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import {
  createFactoryShell,
  registerFabricFactory,
  trySealedFactoryState,
} from "@commonfabric/data-model/fabric-factory";

import type {
  IStorageManager,
  MemorySpace,
  State,
} from "../src/storage/interface.ts";
import { V2StorageTransaction } from "../src/storage/v2-transaction.ts";

const SPACE = "did:test:factory-storage-atomicity" as MemorySpace;
const REF = {
  identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  symbol: "factory",
} as const;
const ADDRESS = {
  space: SPACE,
  scope: "space" as const,
  id: "of:factory-storage-atomicity" as const,
  type: "application/json" as const,
  path: [] as string[],
};

const shell = (symbol: string = REF.symbol) =>
  createFactoryShell({
    kind: "module",
    ref: { ...REF, symbol },
  });

const managerWith = (value: FabricValue): IStorageManager => {
  const state: State = {
    the: ADDRESS.type,
    of: ADDRESS.id,
    is: value,
  } as State;
  const replica = {
    did: () => SPACE,
    get: () => state,
    getDocument: () => undefined,
  };
  return {
    open: () => ({ replica }),
  } as unknown as IStorageManager;
};

Deno.test("storage v2 freezes and seals a live factory returned by a transaction read", () => {
  const live = registerFabricFactory(() => undefined, "module", {
    kind: "module",
    rootToken: {},
    ref: REF,
  });
  assertEquals(Object.isFrozen(live), false);
  assertEquals(trySealedFactoryState(live), undefined);

  const tx = new V2StorageTransaction(managerWith(live));
  const result = tx.read(ADDRESS);

  assert(result.ok);
  assertStrictEquals(result.ok.value, live);
  assert(Object.isFrozen(result.ok.value));
  assertEquals(trySealedFactoryState(live), {
    kind: "module",
    ref: REF,
  });
});

Deno.test("storage v2 rejects an arbitrary function returned by a transaction read", () => {
  const arbitrary = (() => undefined) as unknown as FabricValue;
  const tx = new V2StorageTransaction(managerWith(arbitrary));

  assertThrows(
    () => tx.read(ADDRESS),
    Error,
    "arbitrary function",
  );
});

Deno.test("storage v2 treats equal factory shells as a no-op and changed state as a root write", () => {
  const equalTx = new V2StorageTransaction(managerWith(shell()));
  const equalWrite = equalTx.write(ADDRESS, shell());
  assert(equalWrite.ok);
  assertEquals([...equalTx.getWriteDetails(SPACE)], []);

  const changedTx = new V2StorageTransaction(managerWith(shell()));
  const replacement = shell("replacement");
  const changedWrite = changedTx.write(ADDRESS, replacement);
  assert(changedWrite.ok);
  const details = [...changedTx.getWriteDetails(SPACE)];
  assertEquals(details.length, 1);
  assertEquals(details[0].address.path, []);
  assertStrictEquals(details[0].value, replacement);
});
