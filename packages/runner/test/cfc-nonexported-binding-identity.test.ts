import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { getVerifiedProvenance } from "../src/harness/verified-provenance.ts";
import type { ImplementationIdentity } from "../src/cfc/types.ts";

// CT-1665: An owner-protected field bound by `WriteAuthorizedBy<T, typeof fn>`
// compiles to a verified-binding `writeAuthorizedBy` claim. At commit the CFC
// verifier resolves the authoring handler's identity — sourceFile/bindingPath
// — from the function's content-addressed provenance (`bindingIdentity`,
// recorded by Engine.recordModuleProvenance from the transformer's
// `__cfBindVerifiedBinding` annotation on the FACTORY object). A handler
// declared as a NON-exported module-scope const (the shape used throughout
// system/profile-home.tsx) surfaces through the `__cfReg` registration sink —
// the gap this test guards is that sink registration carrying the binding
// identity, without which the write is rejected with
// "writeAuthorizedBy requires a trusted verified binding identity".
//
// Scope: these tests assert the writer identity is REGISTERED (provenance
// carries the bindingIdentity) and RESOLVES onto transactions while handlers
// run — the value the CFC verifier consumes at commit — under `observe`. A
// full enforce-mode, end-to-end "the write is accepted" assertion additionally
// needs trust-snapshot + owner-principal + trusted-event provenance setup,
// which profile-owner-cfc.test.ts drives via a mocked authoring identity.

const signer = await Identity.fromPassphrase("ct1665-repro");
const space = signer.did();

const INTERNAL_SRC = `/// <cts-enable />
  import { handler, pattern, Writable, WriteAuthorizedBy } from "commonfabric";
  const setName = handler<{ name?: string }, { name: Writable<string> }>(
    (event, state) => { state.name.set(event.name ?? ""); },
  );
  const setAvatar = handler<{ avatar?: string }, { avatar: Writable<string> }>(
    (event, state) => { state.avatar.set(event.avatar ?? ""); },
  );
  export default pattern(() => {
    const name = new Writable<WriteAuthorizedBy<string, typeof setName>>("").for("name");
    const avatar = new Writable<WriteAuthorizedBy<string, typeof setAvatar>>("").for("avatar");
    return { name, avatar, setName: setName({ name }), setAvatar: setAvatar({ avatar }) };
  });
`;

// Same handlers but EXPORTED — worked before the fix; guards against regression.
const EXPORTED_SRC = INTERNAL_SRC.replace(
  / {2}const set/g,
  "  export const set",
);

const PROFILE_HOME_SRC = Deno.readTextFileSync(
  new URL("../../patterns/system/profile-home.tsx", import.meta.url),
);

function programFor(src: string): RuntimeProgram {
  return { main: "/main.tsx", files: [{ name: "/main.tsx", contents: src }] };
}

function recordedBindingPaths(rt: Runtime): string[][] {
  // The binding identity lives on each registered function's content-addressed
  // provenance (the former `verifiedBindingMetadata` map is gone — PR E2);
  // enumerate the engine's implementation index to reach the registered fns.
  const reg = (rt.harness as any).executableRegistry;
  const byRef = reg.verifiedImplementationsByEntryRef as Map<
    string,
    Map<string, unknown>
  >;
  const out: string[][] = [];
  for (const bucket of byRef.values()) {
    for (const fn of bucket.values()) {
      const path = getVerifiedProvenance(fn)?.bindingIdentity?.bindingPath;
      if (Array.isArray(path)) out.push(path);
    }
  }
  return out;
}

// Capture the bindingPaths of the writer identities STAMPED on transactions
// while a handler runs — the value the CFC verifier consumes at commit.
// Channel-agnostic: the identity may resolve through the content-addressed
// provenance WeakMap or the legacy implementationRef registry; what matters
// is the identity (with its bindingPath) reaching the transaction.
async function bindingPathsResolvedDuring(
  rt: Runtime,
  fn: () => void,
): Promise<string[][]> {
  const proto = ExtendedStorageTransaction.prototype;
  const orig = proto.setCfcImplementationIdentity;
  const resolved: string[][] = [];
  proto.setCfcImplementationIdentity = function (
    identity: ImplementationIdentity | undefined,
  ) {
    const bindingPath = (identity as { bindingPath?: string[] } | undefined)
      ?.bindingPath;
    if (Array.isArray(bindingPath)) resolved.push(bindingPath);
    return orig.call(this, identity);
  };
  try {
    fn();
    await (rt as any).idle?.();
  } finally {
    proto.setCfcImplementationIdentity = orig;
  }
  return resolved;
}

describe("CT-1665: verified binding metadata for non-exported handlers", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  const newRuntime = () =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "observe",
    });

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });
  afterEach(async () => {
    await storageManager?.close();
  });

  for (
    const [label, src] of [["internal", INTERNAL_SRC], [
      "exported",
      EXPORTED_SRC,
    ]] as const
  ) {
    it(`resolves the writer identity when ${label} handlers run`, async () => {
      const rt = newRuntime();
      try {
        const tx = rt.edit();
        const pattern = await rt.patternManager.compilePattern(
          programFor(src),
          { space, tx },
        );
        const resultCell = rt.getCell<Record<string, unknown>>(
          space,
          `ct1665-${label}`,
          undefined,
          tx,
        );
        const r = rt.run(tx, pattern, {}, resultCell);
        await tx.commit();
        await r.pull();

        // The metadata is registered for both siblings...
        const paths = recordedBindingPaths(rt);
        expect(paths).toContainEqual(["setName"]);
        expect(paths).toContainEqual(["setAvatar"]);

        // ...and resolves through the verifier's lookup as each handler runs.
        const onName = await bindingPathsResolvedDuring(rt, () => {
          r.key("setName").send({ name: "Alice" });
        });
        expect(onName).toContainEqual(["setName"]);

        const onAvatar = await bindingPathsResolvedDuring(rt, () => {
          r.key("setAvatar").send({ avatar: "🦊" });
        });
        expect(onAvatar).toContainEqual(["setAvatar"]);
      } finally {
        await rt.dispose();
      }
    });
  }

  it("registers binding metadata for real profile-home setName/setAvatar/mutateElements", async () => {
    const rt = newRuntime();
    try {
      const tx = rt.edit();
      const pattern = await rt.patternManager.compilePattern(
        programFor(PROFILE_HOME_SRC),
        { space, tx },
      );
      const resultCell = rt.getCell<Record<string, unknown>>(
        space,
        "ct1665-profile",
        undefined,
        tx,
      );
      const r = rt.run(tx, pattern, { initialName: "Init" }, resultCell);
      await tx.commit();
      await r.pull();

      const paths = recordedBindingPaths(rt);
      expect(paths).toContainEqual(["setName"]);
      expect(paths).toContainEqual(["setAvatar"]);
      expect(paths).toContainEqual(["mutateElements"]);
    } finally {
      await rt.dispose();
    }
  });

  it("registers binding metadata after resume-by-identity (source-free reload)", async () => {
    const rt1 = newRuntime();
    const rt2 = newRuntime();
    try {
      const tx1 = rt1.edit();
      const pm1 = rt1.patternManager;
      const cold = await pm1.compilePattern(programFor(INTERNAL_SRC), {
        space,
        tx: tx1,
      });
      const resultCell1 = rt1.getCell<Record<string, unknown>>(
        space,
        "ct1665-resume",
        undefined,
        tx1,
      );
      const r1 = rt1.run(tx1, cold, {}, resultCell1);
      await tx1.commit();
      await r1.pull();
      await pm1.flushCompileCacheWrites();
      await rt1.storageManager.synced();

      const pm2 = rt2.patternManager;
      const tx2 = rt2.edit();
      const resultCell2 = rt2.getCell<Record<string, unknown>>(
        space,
        "ct1665-resume",
        undefined,
        tx2,
      );
      await tx2.commit();
      await resultCell2.sync();
      await rt2.start(resultCell2);
      await resultCell2.pull();

      expect(pm2.getCompileCacheStats().byIdentityHits).toBeGreaterThan(0);
      const paths = recordedBindingPaths(rt2);
      expect(paths).toContainEqual(["setName"]);
      expect(paths).toContainEqual(["setAvatar"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});
