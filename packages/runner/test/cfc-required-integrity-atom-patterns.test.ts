import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareBoundaryCommit } from "../src/cfc/prepare-engine.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase(
  "cfc required integrity atom pattern test",
);
const space = signer.did();

const authorizedRequestAtom = {
  type: "https://commonfabric.org/cfc/atom/AuthorizedRequest",
  policy: "fetchData-sink-gate",
  endpoint: "GET /gmail/v1/users/me/messages",
  requestDigest: "cfc:fetch-request:abc123",
  codeHash: "Builtin(fetchData)",
  user: space,
} as const;

const networkProvenanceAtom = {
  type: "https://commonfabric.org/cfc/atom/NetworkProvenance",
  host: "gmail.googleapis.com",
  tls: true,
  requestDigest: "cfc:fetch-request:abc123",
  codeHash: "Builtin(fetchData)",
} as const;

const sourceSchema = {
  type: "number",
  ifc: {
    integrity: [authorizedRequestAtom, networkProvenanceAtom],
  },
} as const satisfies JSONSchema;

const requiredIntegrityAtomPatternSchema = {
  type: "number",
  ifc: {
    requiredIntegrity: [
      {
        type: "https://commonfabric.org/cfc/atom/AuthorizedRequest",
        endpoint: "GET /gmail/v1/users/me/messages",
      },
      {
        type: "https://commonfabric.org/cfc/atom/NetworkProvenance",
        tls: true,
      },
    ],
  },
} as const satisfies JSONSchema;

const missingIntegrityAtomPatternSchema = {
  type: "number",
  ifc: {
    requiredIntegrity: [
      {
        type: "https://commonfabric.org/cfc/atom/NetworkProvenance",
        tls: false,
      },
    ],
  },
} as const satisfies JSONSchema;

describe("CFC requiredIntegrity atom patterns", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("accepts subset object patterns in requiredIntegrity", async () => {
    let tx = runtime.edit();
    const source = runtime.getCell<number>(
      space,
      "required-atom-source",
      sourceSchema,
      tx,
    );
    source.withTx(tx).set(7);
    await prepareBoundaryCommit(tx);
    await tx.commit();

    tx = runtime.edit();
    const target = runtime.getCell<number>(
      space,
      "required-atom-target",
      undefined,
      tx,
    );
    target.withTx(tx).set(
      source.withTx(tx).asSchema(requiredIntegrityAtomPatternSchema).get() ?? 0,
    );

    await expect(prepareBoundaryCommit(tx)).resolves.toBeUndefined();
  });

  it("rejects requiredIntegrity object patterns that do not match", async () => {
    let tx = runtime.edit();
    const source = runtime.getCell<number>(
      space,
      "required-atom-source-miss",
      sourceSchema,
      tx,
    );
    source.withTx(tx).set(11);
    await prepareBoundaryCommit(tx);
    await tx.commit();

    tx = runtime.edit();
    const target = runtime.getCell<number>(
      space,
      "required-atom-target-miss",
      undefined,
      tx,
    );
    target.withTx(tx).set(
      source.withTx(tx).asSchema(missingIntegrityAtomPatternSchema).get() ?? 0,
    );

    await expect(prepareBoundaryCommit(tx)).rejects.toMatchObject({
      name: "CfcInputRequirementViolationError",
      requirement: "requiredIntegrity",
    });
  });
});
