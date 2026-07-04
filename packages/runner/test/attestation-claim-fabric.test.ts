// Covers the Fabric-aware consistency check in `claim()` (CT-1770). The check
// compares a stored attested value (`expected`) against the replica's current
// value (`actual`) to decide whether the state is unchanged. A `FabricPrimitive`
// keeps its state in private `#fields` with zero enumerable own-props, so a
// naive `deepEqual` reports two distinct same-class instances as equal --
// masking a genuine change as consistent and swallowing the
// `StorageTransactionInconsistent` error the check exists to raise.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { claim } from "../src/storage/transaction/attestation.ts";
import type {
  IAttestation,
  ISpaceReplica,
  State,
} from "../src/storage/interface.ts";
import type { FabricHash } from "@commonfabric/data-model/fabric-primitives";

// A replica whose stored state carries `storedValue`. `getDocument` is
// deliberately absent so `claim()` takes its `read`-based `actual` path (the
// `typeof replica.getDocument === "function"` guard is false), reading the
// stored value straight off the attested state rather than an entity document.
const replicaHolding = (storedValue: FabricBytes): ISpaceReplica => {
  const state: State = {
    the: "application/json",
    of: "of:attest-claim-fabric",
    is: storedValue,
    // A real cause hash is irrelevant to the value comparison under test.
    cause: undefined as unknown as FabricHash,
  } as State;
  return {
    did: () => "did:test:attest" as ReturnType<ISpaceReplica["did"]>,
    get: () => state,
  } as unknown as ISpaceReplica;
};

describe("attestation claim(): Fabric-aware consistency check", () => {
  const address = {
    id: "of:attest-claim-fabric" as const,
    type: "application/json" as const,
    path: [] as string[],
  };

  it("reports ok when the attested value matches the stored value", () => {
    // Two distinct same-content `FabricBytes`: no real change, so the state is
    // consistent.
    const attestation: IAttestation = {
      address,
      value: new FabricBytes(new Uint8Array([1, 2, 3])),
    };
    const replica = replicaHolding(new FabricBytes(new Uint8Array([1, 2, 3])));

    const result = claim(attestation, replica);
    expect(result.ok).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it("reports StateInconsistency when the Fabric value actually changed (CT-1770)", () => {
    // The attested value and the stored value are distinct `FabricBytes` that
    // differ only in byte content. `deepEqual` sees two zero-own-prop instances
    // of the same class and calls them equal, so the check masks the change and
    // returns `{ ok }`; `valueEqual` compares by content hash and surfaces the
    // `StorageTransactionInconsistent` error.
    const attestation: IAttestation = {
      address,
      value: new FabricBytes(new Uint8Array([1, 2, 3])),
    };
    const replica = replicaHolding(new FabricBytes(new Uint8Array([4, 5, 6])));

    const result = claim(attestation, replica);
    expect(result.error).toBeDefined();
    expect(result.error?.name).toBe("StorageTransactionInconsistent");
  });
});
