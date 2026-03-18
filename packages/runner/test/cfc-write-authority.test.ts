import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import {
  builtinImplementationIdentity,
  type CfcImplementationIdentity,
  codeHashImplementationIdentity,
} from "../src/cfc/implementation-identity.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("cfc write authority test");
const space = signer.did();

const incrementHandlerAtom = {
  type: "https://commonfabric.org/cfc/atom/CodeHash",
  hash: "sha256:increment-handler",
} as const;

const decrementHandlerAtom = {
  type: "https://commonfabric.org/cfc/atom/CodeHash",
  hash: "sha256:decrement-handler",
} as const;

const builtinMapAtom = {
  type: "https://commonfabric.org/cfc/atom/Builtin",
  name: "map",
} as const;

const counterSchema = {
  type: "object",
  properties: {
    count: {
      type: "number",
      default: 0,
      ifc: {
        writeAuthorizedBy: [incrementHandlerAtom, decrementHandlerAtom],
      },
    },
  },
} as const satisfies JSONSchema;

const builtinCounterSchema = {
  type: "object",
  properties: {
    count: {
      type: "number",
      default: 0,
      ifc: {
        writeAuthorizedBy: [builtinMapAtom],
      },
    },
  },
} as const satisfies JSONSchema;

describe("CFC write authority", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.abort();
    await runtime.dispose();
    await storageManager.close();
  });

  async function seedCounter(
    entityId: string,
    schema: JSONSchema,
    implementationIdentity: CfcImplementationIdentity,
  ) {
    const counter = runtime.getCell(space, entityId, schema, tx);
    counter.withTx(tx).set({ count: 0 });
    await prepareCfcCommitIfNeeded(tx, { implementationIdentity });
    const committed = await tx.commit();
    expect(committed.error).toBeUndefined();
    tx = runtime.edit();
    return runtime.getCell(space, entityId, schema, tx);
  }

  it("allows writes from authorized code identities", async () => {
    const incrementIdentity = codeHashImplementationIdentity(
      "sha256:increment-handler",
    );
    const counter = await seedCounter(
      "counter-authorized",
      counterSchema,
      incrementIdentity,
    );
    counter.key("count").withTx(tx).set(1);

    await expect(
      prepareCfcCommitIfNeeded(tx, {
        implementationIdentity: incrementIdentity,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects writes from unauthorized code identities", async () => {
    const counter = await seedCounter(
      "counter-unauthorized",
      counterSchema,
      codeHashImplementationIdentity("sha256:increment-handler"),
    );
    counter.key("count").withTx(tx).set(1);

    await expect(
      prepareCfcCommitIfNeeded(tx, {
        implementationIdentity: codeHashImplementationIdentity(
          "sha256:malicious-handler",
        ),
      }),
    ).rejects.toMatchObject({
      name: "CfcOutputTransitionViolationError",
      requirement: "writeAuthorizedBy",
      path: "/count",
    });
  });

  it("allows builtins named in writeAuthorizedBy", async () => {
    const mapIdentity = builtinImplementationIdentity("map");
    const counter = await seedCounter(
      "counter-builtin-authorized",
      builtinCounterSchema,
      mapIdentity,
    );
    counter.key("count").withTx(tx).set(1);

    await expect(
      prepareCfcCommitIfNeeded(tx, {
        implementationIdentity: mapIdentity,
      }),
    ).resolves.toBeUndefined();
  });
});
