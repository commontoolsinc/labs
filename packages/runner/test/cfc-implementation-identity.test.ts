import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { raw } from "../src/module.ts";
import { Runtime } from "../src/runtime.ts";
import { resolvePolicyFacingImplementationIdentity } from "../src/cfc/implementation-identity.ts";
import { getTopFrame } from "../src/builder/pattern.ts";
import type { Harness } from "../src/harness/types.ts";

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

  it("stamps registered raw builtins with a stable builtin identity", () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
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

  it("threads builtin implementation identity through the active execution frame", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "observe",
    });

    const captured: Array<unknown> = [];
    runtime.moduleRegistry.addModuleByRef(
      "frame-builtin",
      raw((_inputsCell) => {
        captured.push(getTopFrame()?.implementationIdentity);
        return () => undefined;
      }),
    );

    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      signer.did(),
      "cfc-builtin-frame-identity",
      undefined,
      tx,
    );
    runtime.runner.run(
      tx,
      runtime.moduleRegistry.getModule("frame-builtin"),
      {},
      resultCell,
    );
    await tx.commit();
    await runtime.idle();

    expect(captured[0]).toEqual({
      kind: "builtin",
      builtinId: "frame-builtin",
    });
  });

  it("leaves unregistered raw modules without a builtin identity", () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
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

  it("leaves unsafe-host helpers untrusted for policy-facing identity", () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "observe",
    });

    const captured: Array<unknown> = [];
    runtime.moduleRegistry.addModuleByRef(
      "unsafe-host:0",
      raw((inputsCell) => {
        captured.push(inputsCell.tx?.getCfcState().implementationIdentity);
        return () => undefined;
      }),
    );

    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      signer.did(),
      "cfc-unsafe-host-identity",
      undefined,
      tx,
    );
    runtime.runner.run(
      tx,
      runtime.moduleRegistry.getModule("unsafe-host:0"),
      {},
      resultCell,
    );

    expect(captured[0]).toBeUndefined();
    tx.abort("test-complete");
  });

  it("resolves verified compiled modules through the current load and source location", () => {
    const implementation = Object.assign(() => undefined, {
      src: "/main.tsx:4:12",
    });
    const harness = {
      getVerifiedFunctionInLoad: () => implementation,
      isVerifiedSourceInLoad: () => true,
      getVerifiedBundleId: () => "bundle-hash-1",
      getVerifiedBindingMetadata: () => ({
        sourceFile: "/main.tsx",
        bindingPath: ["localFunction"],
      }),
    } satisfies Pick<
      Harness,
      | "getVerifiedBindingMetadata"
      | "getVerifiedBundleId"
      | "getVerifiedFunctionInLoad"
      | "isVerifiedSourceInLoad"
    >;
    const module = {
      type: "javascript" as const,
      implementationRef: "verified-implementation-ref",
    };
    expect(
      resolvePolicyFacingImplementationIdentity(module, {
        verifiedLoadId: "verified-load-1",
        harness,
        implementation,
      }),
    ).toEqual({
      kind: "verified",
      bundleId: "bundle-hash-1",
      sourceFile: "/main.tsx",
      bindingPath: ["localFunction"],
      sourceLocation: { line: 4, column: 12 },
    });
  });

  it("treats unknown implementation identities as untrusted", () => {
    const module = { type: "javascript" as const };
    expect(resolvePolicyFacingImplementationIdentity(module)).toBeUndefined();
  });

  it("fails closed when a verified implementation cannot be rebound through the claimed load", () => {
    const implementation = Object.assign(() => undefined, {
      src: "/main.tsx:4:12",
    });
    const harness = {
      getVerifiedFunctionInLoad: () => undefined,
      isVerifiedSourceInLoad: () => true,
    } satisfies Pick<
      Harness,
      "getVerifiedFunctionInLoad" | "isVerifiedSourceInLoad"
    >;
    const module = {
      type: "javascript" as const,
      implementationRef: "verified-implementation-ref",
    };

    expect(
      resolvePolicyFacingImplementationIdentity(module, {
        verifiedLoadId: "verified-load-1",
        harness,
        implementation,
      }),
    ).toEqual({
      kind: "unsupported",
      className: "verified",
      reason:
        "verified compiled policy identity must resolve through the current verified load",
    });
  });

  it("fails closed when a verified source location resolves outside the current bundle", () => {
    const implementation = Object.assign(() => undefined, {
      src: "/other-bundle.tsx:4:12",
    });
    const harness = {
      getVerifiedFunctionInLoad: () => implementation,
      isVerifiedSourceInLoad: () => false,
    } satisfies Pick<
      Harness,
      "getVerifiedFunctionInLoad" | "isVerifiedSourceInLoad"
    >;
    const module = {
      type: "javascript" as const,
      implementationRef: "verified-implementation-ref",
    };

    expect(
      resolvePolicyFacingImplementationIdentity(module, {
        verifiedLoadId: "verified-load-1",
        harness,
        implementation,
      }),
    ).toEqual({
      kind: "unsupported",
      className: "verified",
      reason:
        "verified compiled policy identity must map back into the current verified bundle",
    });
  });
});
