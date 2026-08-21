// S-C heal-on-read (verification-coverage.md OW45 seat S-C; RULED
// 2026-08-21 — owner: "ideally compilation happens on the server and
// clients just wait for it, but if that isn't the case yet, then let's
// mark this for a later improvement and do (b)"): a CLIENT that opens a
// space referencing a `patternIdentity` whose program docs the space
// does not hold re-materializes them FROM PATTERN SOURCE — the verified
// source closure of any other space this client has open — under the
// client's OWN identity (ordinary authored writes; no carriage
// question, and the serving posture stays fail-closed per OW31 FLAG-4:
// a serving runtime never heals through this path — its heal is S-A's
// carriage-borne replicate trigger).
//
// The defect class this closes going forward (rootcause §1, under ON):
// a created piece's program commit dies with a reload; the space then
// references a patternIdentity nobody can load FROM THAT SPACE, so the
// serving loop parks (OW46's stuck streak names it) and every fresh
// client renders the `#id` placeholder forever. With the heal, the
// next adopt/open re-materializes the program and the space serves.
// (The two gate-evidence spaces — Ada's and Alan's — lived in ephemeral
// test stores; production has none, so this is forward correctness,
// not a repair backlog.)

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { getArtifactEntryRef } from "../src/builder/pattern-metadata.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const homeSigner = await Identity.fromPassphrase("heal-on-read home");
const HOME = homeSigner.did() as MemorySpace;
const targetSigner = await Identity.fromPassphrase("heal-on-read target");
const TARGET = targetSigner.did() as MemorySpace;
const target2Signer = await Identity.fromPassphrase("heal-on-read target-2");
const TARGET2 = target2Signer.did() as MemorySpace;

const COUNTER_PATTERN = [
  "import { computed, pattern } from 'commonfabric';",
  "export default pattern<{ n: number }, { total: number }>(",
  "  ({ n }) => ({ total: computed(() => n * 5) }),",
  ");",
].join("\n");

describe("pattern heal-on-read (OW45 S-C)", () => {
  let server: MemoryV2Server.Server;
  let clientManager: EmulatedStorageManager;
  let client: Runtime;

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: homeSigner,
    });
    client = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
    });
  });

  afterEach(async () => {
    await client?.dispose();
    await clientManager?.close();
    await server.close();
  });

  it("a load in a space lacking program docs heals from an open donor space and the docs become durable there", async () => {
    // The donor: compile into HOME — source + compiled closures persist
    // there under the client's identity.
    const compiled = await client.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_PATTERN }],
    }, { space: HOME });
    await client.patternManager.flushCompileCacheWrites();
    const identity = getArtifactEntryRef(compiled)?.identity;
    expect(typeof identity).toBe("string");

    // The broken space: TARGET references the identity (the adopt/open
    // is the load call itself) and holds NO program docs. Pre-fix the
    // load returned undefined — the space was unhealable and every
    // fresh runtime (the serving loop included) rendered the #id
    // placeholder forever. Post-fix: the client heals from HOME's
    // verified source closure and serves the pattern.
    const healed = await client.patternManager.loadPatternByIdentity(
      identity!,
      "default",
      TARGET,
    );
    expect(healed).toBeDefined();

    // Durability — the space itself now carries the program: a FRESH
    // runtime that opens ONLY the target space loads the pattern from
    // it (this is what un-parks the serving loop's demand cycle — the
    // heal's commit re-arms the load, the piece starts, and OW46's
    // deferral streak retires with the start).
    await client.patternManager.flushCompileCacheWrites();
    await client.storageManager.synced();
    const freshManager = EmulatedStorageManager.connectTo(server, {
      as: targetSigner,
    });
    const fresh = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: freshManager,
    });
    try {
      const loaded = await fresh.patternManager.loadPatternByIdentity(
        identity!,
        "default",
        TARGET,
      );
      expect(loaded).toBeDefined();
    } finally {
      await fresh.dispose();
      await freshManager.close();
    }
  });

  it("a SERVING-posture runtime never heals through this path (OW31 FLAG-4 stays fail-closed)", async () => {
    // Same donor setup on the CLIENT.
    const compiled = await client.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_PATTERN }],
    }, { space: HOME });
    await client.patternManager.flushCompileCacheWrites();
    await client.storageManager.synced();
    const identity = getArtifactEntryRef(compiled)?.identity;
    expect(typeof identity).toBe("string");

    // A serving runtime with the SAME donor visible must not
    // re-materialize program docs into a space it serves — the serving
    // side's heal is S-A's carriage-borne trigger, and its detached
    // compile flows stay fail-closed.
    const servingManager = EmulatedStorageManager.connectTo(server, {
      as: homeSigner,
    });
    const serving = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: servingManager,
      servingPosture: true,
      experimental: { serverExecution: true, systemPatternAutoUpdate: false },
    });
    try {
      // Open the donor so it would be visible to a (wrongly) enabled scan.
      const probe = serving.getCell<{ n: number }>(HOME, "posture-probe");
      await probe.sync();
      const loaded = await serving.patternManager.loadPatternByIdentity(
        identity!,
        "default",
        TARGET2,
      );
      expect(loaded).toBeUndefined();
      // And the space stayed empty: a fresh reader still cannot load
      // from it.
      const readerManager = EmulatedStorageManager.connectTo(server, {
        as: target2Signer,
      });
      const reader = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: readerManager,
      });
      try {
        const stillMissing = await reader.patternManager
          .loadPatternByIdentity(identity!, "default", TARGET2);
        expect(stillMissing).toBeUndefined();
      } finally {
        await reader.dispose();
        await readerManager.close();
      }
    } finally {
      await serving.dispose();
      await servingManager.close();
    }
  });
});
