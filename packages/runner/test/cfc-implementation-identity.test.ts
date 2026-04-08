import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { raw } from "../src/module.ts";
import { Runtime } from "../src/runtime.ts";
import { resolvePolicyFacingImplementationIdentity } from "../src/cfc/implementation-identity.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-implementation-identity",
);

describe("CFC builtin implementation identity", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  it("stamps registered raw builtins with a stable builtin identity", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      memoryVersion: "v2",
      cfcEnforcementMode: "observe",
    });

    const captured: Array<unknown> = [];
    runtime.moduleRegistry.addModuleByRef(
      "test-builtin",
      raw((inputsCell) => {
        captured.push(inputsCell.tx?.getCfcState().implementationIdentity);
        return () => undefined;
      }),
    );

    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      signer.did(),
      "cfc-builtin-identity",
      undefined,
      tx,
    );
    runtime.runner.run(
      tx,
      runtime.moduleRegistry.getModule("test-builtin"),
      {},
      resultCell,
    );

    expect(captured[0]).toEqual({
      kind: "builtin",
      builtinId: "test-builtin",
    });
    tx.abort("test-complete");
  });

  it("leaves unregistered raw modules without a builtin identity", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      memoryVersion: "v2",
      cfcEnforcementMode: "observe",
    });

    const captured: Array<unknown> = [];
    const module = raw((inputsCell) => {
      captured.push(inputsCell.tx?.getCfcState().implementationIdentity);
      return () => undefined;
    });

    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      signer.did(),
      "cfc-unregistered-raw",
      undefined,
      tx,
    );
    runtime.runner.run(tx, module, {}, resultCell);

    expect(captured[0]).toBeUndefined();
    tx.abort("test-complete");
  });

  it("treats verified compiled modules as unsupported until richer policy ids land", () => {
    const module = { type: "javascript" as const };
    expect(
      resolvePolicyFacingImplementationIdentity(module, {
        verifiedLoadId: "verified-load-1",
      }),
    ).toEqual({
      kind: "unsupported",
      className: "verified",
      reason:
        "verified compiled policy identity is blocked until the richer bundle/path/location/hash identity lands",
    });
  });

  it("treats unknown implementation identities as untrusted", () => {
    const module = { type: "javascript" as const };
    expect(resolvePolicyFacingImplementationIdentity(module)).toBeUndefined();
  });
});
