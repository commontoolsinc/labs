// The space-root ensure core's pins (OW45 arm-B server-ensure stage 1;
// design PR #6209 §1/§2): existence + freshness at the runner level —
// creation with the OCC re-check, provenance stamping, the per-attempt
// stamp hook, and the aged-root reconcile that replaces an obsolete
// patternIdentity from the ensure itself. The serving SEAT (owed step,
// lease, counters, owner snapshot) is pinned in
// executor-space-root-ensure.test.ts; these pins hold the core steady for
// both callers (the serving seat and the client controller's delegated
// creation arm).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  createSpaceRootIfAbsent,
  DEFAULT_APP_PATTERN_SOURCE,
  ensureSpaceRootPattern,
  HOME_PATTERN_SOURCE,
  resolveSpaceRootPattern,
  spaceRootPatternConfig,
} from "../src/ensure-space-root.ts";
import {
  getEntityId,
  getPatternIdentityRef,
  getPatternSource,
  resolveEntryIdentity,
  Runtime,
  type RuntimeFetch,
} from "../src/index.ts";
import type { MemorySpace } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("ensure space root core");
const space = signer.did() as MemorySpace;

const HOME_PATH = "/api/patterns/system/home.tsx";
const APP_PATH = "/api/patterns/system/default-app.tsx";

function rootSource(marker: string): string {
  return [
    "import { computed, pattern } from 'commonfabric';",
    "const Root = pattern<Record<string, never>, { marker: string }>(" +
    `() => ({ marker: computed(() => "${marker}") }));`,
    "export default Root;",
    "",
  ].join("\n");
}

describe("space-root ensure core", () => {
  /** The served patterns route, in-process: pathname → TSX. Mutable so a
   * test can age the served source under a persisted root. */
  let files: Map<string, string>;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  const identityFor = (entry: string): Promise<string> =>
    resolveEntryIdentity(entry, (name) => {
      const contents = files.get(name);
      return contents !== undefined
        ? Promise.resolve(contents)
        : Promise.reject(new Error(`not found: ${name}`));
    });

  const fetchStub: RuntimeFetch = (input, _init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url,
    );
    const body = files.get(url.pathname);
    if (body === undefined) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    if (url.searchParams.has("identity")) {
      return identityFor(url.pathname).then((id) => new Response(id));
    }
    return Promise.resolve(new Response(body));
  };

  const createRuntime = (systemPatternAutoUpdate = false): Runtime => {
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      fetch: fetchStub,
      experimental: { systemPatternAutoUpdate },
    });
    return runtime;
  };

  beforeEach(() => {
    files = new Map([
      [HOME_PATH, rootSource("home-v1")],
      [APP_PATH, rootSource("app-v1")],
    ]);
    storageManager = StorageManager.emulate({ as: signer });
  });

  afterEach(async () => {
    await runtime?.patternUpdater.idle();
    await runtime?.idle();
    await runtime?.dispose();
    await storageManager.close();
  });

  it("resolves nothing on a fresh space, then the created root with its provenance", async () => {
    createRuntime();
    expect(await resolveSpaceRootPattern(runtime, space)).toBeUndefined();

    const created = await createSpaceRootIfAbsent(
      runtime,
      space,
      spaceRootPatternConfig(true),
      { fetch: fetchStub },
    );
    expect(created.error).toBeUndefined();
    expect(created.createdByThisCall).toBe(true);
    await runtime.idle();

    const root = await resolveSpaceRootPattern(runtime, space);
    expect(root).toBeDefined();
    // Born with the provenance it will keep: the `system:` ref, and the
    // compiled identity of the served source under its default export.
    expect(getPatternSource(root!)).toBe(HOME_PATTERN_SOURCE);
    const ref = getPatternIdentityRef(root!);
    expect(ref?.identity).toBe(await identityFor(HOME_PATH));
    expect(ref?.symbol).toBe("default");
  });

  it("re-creation converges on ONE root by address (the OCC invariant)", async () => {
    createRuntime();
    const first = await createSpaceRootIfAbsent(
      runtime,
      space,
      spaceRootPatternConfig(true),
      { fetch: fetchStub },
    );
    expect(first.createdByThisCall).toBe(true);
    await runtime.idle();
    const firstRoot = await resolveSpaceRootPattern(runtime, space);

    // The creation CAUSE derives the piece cell's entity id, so a rival
    // creation — here, a second call over a set-up-but-never-started
    // root, whose in-transaction value read is undefined (the computeds
    // never ran, so the fast arm cannot engage) — re-runs setup over the
    // SAME address and the space still holds exactly one root. The
    // client-arm fast path (`existingDefault?.get()` truthy on a live
    // root) is the piece suite's to pin; what the CORE guarantees is
    // address convergence whichever arm fires.
    const second = await createSpaceRootIfAbsent(
      runtime,
      space,
      spaceRootPatternConfig(true),
      { fetch: fetchStub },
    );
    expect(second.error).toBeUndefined();
    await runtime.idle();
    const secondRoot = await resolveSpaceRootPattern(runtime, space);
    expect(getEntityId(secondRoot!)).toEqual(getEntityId(firstRoot!));
  });

  it("runs the stamp hook inside the creation attempt", async () => {
    createRuntime();
    let stamped = 0;
    const created = await createSpaceRootIfAbsent(
      runtime,
      space,
      spaceRootPatternConfig(true),
      {
        fetch: fetchStub,
        stampCreationTx: () => {
          stamped += 1;
        },
      },
    );
    expect(created.createdByThisCall).toBe(true);
    expect(stamped).toBe(1);
    await runtime.idle();
  });

  it("ensure creates a fresh root (reconcile skipped), then resolves it on the next run", async () => {
    createRuntime(true);
    const first = await ensureSpaceRootPattern(runtime, space, {
      isHomeSpace: true,
    });
    expect(first.outcome).toBe("created");
    expect(first.reconcile).toBe("skipped-fresh");
    await runtime.idle();

    const second = await ensureSpaceRootPattern(runtime, space, {
      isHomeSpace: true,
    });
    expect(second.outcome).toBe("resolved-existing");
    // Identity matches the served source, so the awaited reconcile
    // reports the root current.
    expect(second.reconcile).toBe("current");
  });

  it("non-home ensure uses the system default-app source (the unruled custom-URL fork's interim)", async () => {
    createRuntime();
    const result = await ensureSpaceRootPattern(runtime, space, {
      isHomeSpace: false,
    });
    expect(result.outcome).toBe("created");
    await runtime.idle();
    const root = await resolveSpaceRootPattern(runtime, space);
    expect(getPatternSource(root!)).toBe(DEFAULT_APP_PATTERN_SOURCE);
    expect(getPatternIdentityRef(root!)?.identity).toBe(
      await identityFor(APP_PATH),
    );
  });

  it("an aged root's ensure reconciles the obsolete patternIdentity (the updater-ordering pin)", async () => {
    createRuntime(true);
    const created = await ensureSpaceRootPattern(runtime, space, {
      isHomeSpace: true,
    });
    expect(created.outcome).toBe("created");
    await runtime.idle();
    const agedIdentity = await identityFor(HOME_PATH);

    // The served source moves while the root is not running — the aged
    // space. The next ensure must swap the stored identity forward
    // BEFORE anything tries to load the obsolete one.
    files.set(HOME_PATH, rootSource("home-v2"));
    const freshIdentity = await identityFor(HOME_PATH);
    expect(freshIdentity).not.toBe(agedIdentity);

    const ensured = await ensureSpaceRootPattern(runtime, space, {
      isHomeSpace: true,
    });
    expect(ensured.outcome).toBe("resolved-existing");
    expect(ensured.reconcile).toBe("updated");
    await runtime.patternUpdater.idle();
    await runtime.idle();

    const root = await resolveSpaceRootPattern(runtime, space);
    expect(getPatternIdentityRef(root!)?.identity).toBe(freshIdentity);
  });
});
