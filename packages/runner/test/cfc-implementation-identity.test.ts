import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { raw } from "../src/module.ts";
import { Runtime } from "../src/runtime.ts";
import { resolvePolicyFacingImplementationIdentity } from "../src/cfc/implementation-identity.ts";
import { getTopFrame } from "../src/builder/pattern.ts";
import {
  getVerifiedProvenance,
  recordVerifiedProvenance,
} from "../src/harness/verified-provenance.ts";

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

  it("resolves verified compiled modules through provenance, with binding identity and bundle id", () => {
    // PR E2: the implementationRef × verifiedLoadId registry arm is gone; the
    // function object's provenance (recorded during verified evaluation) is
    // the only source of `kind: "verified"`. This drives the resolver through
    // the same registration channel the engine uses.
    const implementation = Object.assign(() => undefined, {
      src: "cf:module/module-hash-1/main.tsx:4:12",
    });
    recordVerifiedProvenance(implementation, {
      identity: "module-hash-1",
      symbol: "localFunction",
      bundleId: "bundle-hash-1",
      bindingIdentity: {
        sourceFile: "/main.tsx",
        bindingPath: ["localFunction"],
      },
    });
    const module = { type: "javascript" as const };
    expect(
      resolvePolicyFacingImplementationIdentity(module, { implementation }),
    ).toEqual({
      kind: "verified",
      moduleIdentity: "module-hash-1",
      symbol: "localFunction",
      bundleId: "bundle-hash-1",
      sourceFile: "/main.tsx",
      bindingPath: ["localFunction"],
      sourceLocation: { line: 4, column: 12 },
    });
  });

  it("registers exported trusted builder bindings with source identity", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const program = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `/// <cts-enable />
          import { handler, pattern, Writable, WriteAuthorizedBy } from "commonfabric";

          export const saveTitle = handler<void, { title: Writable<string> }>(
            (_event, { title }) => {
              title.set(title.get());
            },
          );

          export type SavedTitle = WriteAuthorizedBy<string, typeof saveTitle>;

          export default pattern(() => ({ saveTitle }));
        `,
      }],
    };

    const { main } = await runtime.harness.compileAndEvaluateModules(program);

    // The binding identity rides on the function's content-addressed
    // provenance (recorded by Engine.recordModuleProvenance from the
    // transformer's annotation on the exported factory).
    expect(
      getVerifiedProvenance(
        (main as {
          saveTitle: { implementation: (...args: unknown[]) => unknown };
        }).saveTitle.implementation,
      )?.bindingIdentity,
    ).toEqual({
      sourceFile: "/main.tsx",
      bindingPath: ["saveTitle"],
    });
  });

  it("treats unknown implementation identities as untrusted", () => {
    const module = { type: "javascript" as const };
    expect(resolvePolicyFacingImplementationIdentity(module)).toBeUndefined();
  });

  it("an implementationRef alone grants nothing — a provenance-less function stays untrusted", () => {
    // The legacy-arm-deletion pin (PR E2): under the dual-read window a
    // module's `implementationRef` could still resolve a verified identity
    // through the per-load registry. Post-flip the ref is inert for CFC — a
    // function that was never registered during a verified evaluation has no
    // provenance and gets NO identity, no matter what the module claims.
    const implementation = Object.assign(() => undefined, {
      src: "/main.tsx:4:12",
    });
    const module = {
      type: "javascript" as const,
      implementationRef: "verified-implementation-ref",
    };

    expect(
      resolvePolicyFacingImplementationIdentity(module, { implementation }),
    ).toBeUndefined();
  });

  it("fails closed when the canonical source disagrees with the provenance identity", () => {
    // The provenance analogue of the former out-of-bundle check: a recorded
    // identity must match the module the function's canonical src points
    // into; a mismatch is rejected as unsupported rather than guessed at.
    const implementation = Object.assign(() => undefined, {
      src: "cf:module/other-module-hash/other.tsx:4:12",
    });
    recordVerifiedProvenance(implementation, {
      identity: "module-hash-1",
      symbol: "localFunction",
    });
    const module = { type: "javascript" as const };

    expect(
      resolvePolicyFacingImplementationIdentity(module, { implementation }),
    ).toEqual({
      kind: "unsupported",
      className: "verified",
      reason:
        "provenance identity must match the implementation's canonical source",
    });
  });
});
