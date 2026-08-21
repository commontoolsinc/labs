/**
 * The protocol between the multi-runtime harness and one of its worker
 * realms: the two message shapes, the values they name, and the conversion a
 * key pair takes to travel as one.
 *
 * This module holds no state and runs nothing on load, which is what lets the
 * harness realm import from it. Its counterpart `./multi-runtime-worker.ts` is
 * a worker entry point — loading it installs a `self.onmessage` handler — so
 * nothing outside a worker may import a value from there.
 */

import type { RealmEncodedValue } from "@commonfabric/data-model/codec-realm";
import { FabricKeyPair } from "@commonfabric/data-model/fabric-primitives";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { isCryptoKeyPair, type KeyPairRaw } from "@commonfabric/identity";
import type { SchedulerGraphSnapshot } from "@commonfabric/runner";

/**
 * A request to a worker realm.
 *
 * `args` crosses as one `codec-realm` encoding, that being the format written
 * for a realm boundary, so a command's arguments carry the whole `FabricValue`
 * domain rather than whatever structured cloning preserves of them. `id` and
 * `cmd` are addressing and travel as themselves.
 */
export type WorkerRequest = {
  id: number;
  cmd: string;
  args: RealmEncodedValue;
};

/**
 * A response from a worker realm. `ok` is the command's answer as one
 * `codec-realm` encoding, for the reason {@link WorkerRequest} gives; a
 * command that fails answers with text instead.
 */
export type WorkerResponse =
  | { id: number; ok: RealmEncodedValue }
  | { id: number; error: string };

export type TrustedUiDescriptor = {
  /** `data-ui-pattern` / `data-ui-event-integrity` of the trusted surface. */
  surface: string;
  /** `data-ui-action` of the control inside the surface. */
  action: string;
};

export type RuntimeDiagnosticsSnapshot = {
  graph: SchedulerGraphSnapshot;
  settleStatsHistory: FabricValue[];
  actionRunTrace: FabricValue[];
};

/**
 * Converts a key pair into the form `init` carries it in, a `FabricKeyPair`
 * being what lets key material travel inside the encoded args rather than
 * beside them.
 *
 * A byte pair does not say what algorithm it is for, where a `CryptoKeyPair`
 * reports its own; `identity` only ever produces ed25519, so that is the name
 * the material arm is given.
 *
 * TODO(danfuzz): this pair of conversions belongs in
 * `@commonfabric/identity`, once `Identity` speaks `FabricKeyPair` rather
 * than `KeyPairRaw`. `serializeKeyPairRaw()` there is the function they
 * replace, it having no answer but `null` for the handles arm.
 */
export function fabricFromKeyPairRaw(raw: KeyPairRaw): FabricKeyPair {
  return isCryptoKeyPair(raw)
    ? new FabricKeyPair(raw)
    : new FabricKeyPair("Ed25519", raw.publicKey, raw.privateKey);
}

/**
 * Converts a key pair back into the form `Identity.deserialize()` takes.
 *
 * The material arm's bytes are copied where the handles arm's keys are not, a
 * `CryptoKey` being an opaque handle with no copy to make. So the result of
 * the handles arm holds the very keys the instance holds.
 */
export function keyPairRawFromFabric(pair: FabricKeyPair): KeyPairRaw {
  return pair.hasMaterial
    ? {
      publicKey: pair.publicKeyBytes.slice(),
      privateKey: pair.privateKeyBytes.slice(),
    }
    : pair.cryptoKeyPair;
}
