import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Cell, type Pattern } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import {
  getDerivedInternalCell,
  getMetaLink,
  parseLink,
} from "../src/link-utils.ts";
import { trustExecutable } from "./support/trusted-builder.ts";
import { JSONValue } from "@commonfabric/runner/shared";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isPrimitiveCellLink } from "../src/link-types.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

// Two storage managers that share ONE in-memory server (the persistence
// boundary) but keep SEPARATE client caches. This models a reload: the second
// runtime starts cold and must fetch persisted docs from the server, rather
// than reading the first runtime's warm cache.
class SharedServerStorageManager extends EmulatedStorageManager {
  constructor(as: Identity, server: MemoryV2Server.Server) {
    super({ as, memoryHost: new URL("memory://") }, () => server);
  }
  // The shared server is owned by the test, not by either manager. Closing one
  // manager must not close the server out from under the other; close only this
  // manager's client by invoking the grandparent (plain StorageManager) close.
  override close(): Promise<void> {
    const baseClose = Object.getPrototypeOf(EmulatedStorageManager.prototype)
      .close as (this: EmulatedStorageManager) => Promise<void>;
    return baseClose.call(this);
  }
}

// Regression coverage for CT-1666.
//
// A pattern's derived internal cell carries a build-time default (in home.tsx,
// `const activeTab = new Writable("spaces").for("activeTab")` →
// `derivedInternalCells = [{ partialCause: "activeTab", schema: { default: "spaces" } }]`).
// After the user picks a
// value ("profile") and it is persisted, re-running the pattern must NOT revert
// the cell to the build-time default.
//
// `Runner.applySetupState` reads the persisted internal value and merges the
// build-time default UNDER it (persisted wins). But the internal cell lives in
// a separate content-addressed doc reached only via the result cell's meta link
// — not through the schema/value graph — so the run's awaited sync gate
// (`syncCellsForRunningPattern`) did not load it. The fix makes that gate sync
// the `internal`/`argument` meta docs, so the persisted value is loaded before
// the pattern (re)starts and renders.
//
// `activeTab` is intentionally internal-only here (never exported in `result`),
// matching home.tsx where it is bound only to `<cf-tabs $value={activeTab}>`.
//
// A fresh runtime sharing the same emulated store rehydrates from a cold client
// cache, exercising the load path the gate is responsible for.
describe("rehydrate internal default (CT-1666)", () => {
  let server: MemoryV2Server.Server;
  let sm1: SharedServerStorageManager;
  let sm2: SharedServerStorageManager;

  const pattern: Pattern = {
    argumentSchema: {},
    resultSchema: {},
    derivedInternalCells: [{
      partialCause: "activeTab",
      schema: { default: "spaces" },
    }],
    result: {},
    nodes: [],
  };

  const internalCellOf = (
    runtime: Runtime,
    resultCell: Cell<unknown>,
    partialCause: JSONValue,
  ) => {
    const manifest = resultCell.getMetaRaw("internal");
    expect(manifest).toBeDefined();
    expect(Array.isArray(manifest)).toBe(true);
    if (Array.isArray(manifest)) {
      for (const entry of manifest) {
        if (deepEqual(entry?.partialCause, partialCause)) {
          if ("link" in entry && isPrimitiveCellLink(entry?.link)) {
            const matchingCellLink = parseLink(entry.link, resultCell)!;
            return runtime.getCellFromLink(matchingCellLink);
          }
        }
      }
    }
    return undefined;
  };

  const internalLinkOf = (
    resultCell: Cell<unknown>,
    partialCause: JSONValue,
  ) => {
    const manifest = resultCell.getMetaRaw("internal");
    expect(manifest).toBeDefined();
    expect(Array.isArray(manifest)).toBe(true);
    if (Array.isArray(manifest)) {
      for (const entry of manifest) {
        if (deepEqual(entry?.partialCause, partialCause)) {
          expect(isPrimitiveCellLink(entry?.link)).toBe(true);
          return parseLink(entry.link, resultCell)!;
        }
      }
    }
    throw new Error(`Missing internal manifest entry for ${partialCause}`);
  };

  beforeEach(() => {
    server = new MemoryV2Server.Server({
      authorizeSessionOpen(message) {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
    });
    sm1 = new SharedServerStorageManager(signer, server);
    sm2 = new SharedServerStorageManager(signer, server);
  });
  afterEach(async () => {
    await sm1?.close();
    await sm2?.close();
    await server?.close();
  });

  it("preserves a user-set internal value across a cold-cache reload", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm2,
    });
    try {
      // Session 1: first run seeds the build-time default, then the user picks
      // "profile". Persist it to the shared server.
      const rc1 = rt1.getCell<Record<string, never>>(space, "home-result");
      await rt1.runSynced(rc1, trustExecutable(rt1, pattern), {});
      await rc1.pull();

      const internal1 = internalCellOf(rt1, rc1, "activeTab")!;
      expect(internal1.get()).toEqual("spaces");

      const tx = rt1.edit();
      internal1.withTx(tx).set("profile");
      await tx.commit();
      await sm1.synced();
      expect(internal1.get()).toEqual("profile");

      // Session 2: a fresh runtime with a COLD cache rehydrates the SAME result
      // cell and re-runs the pattern through the awaited sync gate. The persisted
      // "profile" must survive — it must not be reverted to the build-time
      // default "spaces".
      const rc2 = rt2.getCell<Record<string, never>>(space, "home-result");
      await rt2.runSynced(rc2, trustExecutable(rt2, pattern), {});
      await rc2.pull();

      const internal2 = internalCellOf(rt2, rc2, "activeTab")!;
      expect(internal2.get()).toEqual("profile");
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("keeps a pre-versioning generated id for an unchanged pattern", async () => {
    const generatedCause = { $generated: 0 };
    const generatedPattern: Pattern = {
      argumentSchema: {},
      resultSchema: {
        type: "object",
        properties: { active: { type: "string" } },
      },
      derivedInternalCells: [{
        partialCause: generatedCause,
        schema: { type: "string", default: "spaces" },
      }],
      result: {
        active: { $alias: { partialCause: generatedCause, path: [] } },
      },
      nodes: [],
    };
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm2,
    });
    try {
      const rc1 = rt1.getCell<{ active: string }>(
        space,
        "legacy-generated-result",
      );
      await rt1.runSynced(
        rc1,
        trustExecutable(rt1, generatedPattern),
        {},
      );
      await rc1.pull();

      // Forge the exact pre-#4916 manifest shape. The fresh descriptor has no
      // out-of-band artifact association, so it derives the legacy id whose
      // preimage contains only the generated partial cause.
      const legacyCell = getDerivedInternalCell(rc1, {
        partialCause: { $generated: 0 },
        schema: { type: "string", default: "spaces" },
      });
      const legacyLink = legacyCell.getAsWriteRedirectLink({
        base: rc1,
        includeSchema: true,
      });
      const tx = rt1.edit();
      legacyCell.withTx(tx).set("profile");
      rc1.withTx(tx).setMetaRaw("internal", [{
        partialCause: generatedCause,
        link: legacyLink,
      }]);
      await tx.commit();
      await sm1.synced();

      const rc2 = rt2.getCell<{ active: string }>(
        space,
        "legacy-generated-result",
      );
      await rt2.runSynced(
        rc2,
        trustExecutable(rt2, generatedPattern),
        {},
      );
      expect((await rc2.pull()).active).toBe("profile");

      const resumedManifest = rc2.getMetaRaw("internal");
      expect(Array.isArray(resumedManifest)).toBe(true);
      const resumedEntry = Array.isArray(resumedManifest)
        ? resumedManifest[0]
        : undefined;
      expect(resumedEntry?.patternIdentity).toBeUndefined();
      expect(parseLink(resumedEntry?.link, rc2)?.id).toBe(
        parseLink(legacyLink, rc1).id,
      );
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("materializes internal manifest cells from a cold-cache result query", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm2,
    });
    try {
      const inputs = { selectedBy: "client-a" };
      const rc1 = rt1.getCell<Record<string, never>>(
        space,
        "home-result-query-materialization",
      );
      await rt1.runSynced(rc1, trustExecutable(rt1, pattern), inputs);
      await rc1.pull();

      const internal1 = internalCellOf(rt1, rc1, "activeTab")!;
      const tx = rt1.edit();
      internal1.withTx(tx).set("profile");
      await tx.commit();
      await sm1.synced();

      const internalLink = internalLinkOf(rc1, "activeTab");
      const argumentLink = getMetaLink(rc1, "argument");
      expect(argumentLink).toBeDefined();
      const provider2 = sm2.open(space) as unknown as {
        get(
          id: string,
          scope?: string,
        ):
          | { value?: unknown; argument?: unknown; internal?: unknown }
          | undefined;
      };
      expect(provider2.get(internalLink.id, internalLink.scope))
        .toBeUndefined();
      expect(provider2.get(argumentLink!.id, argumentLink!.scope))
        .toBeUndefined();

      const rc2 = rt2.getCell<Record<string, never>>(
        space,
        "home-result-query-materialization",
      );
      await rc2.sync();
      await sm2.synced();

      const resultDoc = provider2.get(
        rc2.getAsNormalizedFullLink().id,
        rc2.getAsNormalizedFullLink().scope,
      );
      expect(resultDoc).toBeDefined();
      expect(resultDoc?.internal).toBeDefined();
      expect(resultDoc?.argument).toBeDefined();

      const internalDoc = provider2.get(internalLink.id, internalLink.scope);
      expect(internalDoc).toBeDefined();
      expect(internalDoc?.value).toEqual("profile");

      const argumentDoc = provider2.get(argumentLink!.id, argumentLink!.scope);
      expect(argumentDoc).toBeDefined();
      expect(argumentDoc?.value).toEqual(inputs);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});
