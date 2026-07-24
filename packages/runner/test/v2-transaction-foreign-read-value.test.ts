import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import type { EntityDocument } from "@commonfabric/memory/v2";
import type { CellScope } from "../src/builder/types.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

/**
 * C3.13-1 — served foreign-read VALUE carriage, at the transaction seam.
 *
 * WHY: a served cross-space point read lands the foreign document in the
 * executor Worker's read-only mount, but before C3.13 the Worker's derivation
 * read of that foreign source went through `loadRoot` → the empty HOME replica
 * and folded `Default<0>`. The fix consults `IStorageManager.foreignReadDocument`
 * in `loadRoot` (v2-transaction.ts) so the read hydrates from the mount VALUE,
 * and — LOAD-BEARING — skips `validate()`'s `claim()` for the mount-served doc
 * (whose home replica is empty, so a claim() re-read would throw
 * StateInconsistency). The seam is exercised here with a minimal
 * `foreignReadDocument` over a real emulated manager; the full Runtime-over-
 * HostStorageManager derivation is C3.13-2 (executor-foreign-read-value.test.ts).
 *
 * DISCRIMINATION (verified by reverting the shipped change):
 *   - remove the `loadRoot` mount consult  → case (i) reds (value undefined).
 *   - remove the `validate()` mountServed skip → case (ii) reds
 *     (StateInconsistency on commit).
 */

const HOME_TYPE = "application/json";
const HOME_DOC: URI = "of:c3-13-home-doc";
const FOREIGN_DOC: URI = "of:c3-13-foreign-doc";

/**
 * A minimal executor-shaped manager: a real emulated per-space replica set
 * (so home writes/reads and commits are genuine) plus a controllable served
 * foreign-read mount, mirroring `HostStorageManager.foreignReadDocument`
 * (home-guarded, space-scoped lookup).
 */
class MountEmulatedStorageManager extends EmulatedStorageManager {
  homeSpace?: MemorySpace;
  readonly #mounts = new Map<string, { document: EntityDocument | null }>();

  setMount(space: MemorySpace, id: URI, document: EntityDocument | null): void {
    this.#mounts.set(`${space}\0${id}`, { document });
  }

  clearMounts(): void {
    this.#mounts.clear();
  }

  foreignReadDocument(
    space: MemorySpace,
    id: URI,
    _scope?: CellScope,
  ): { document: EntityDocument | null } | undefined {
    // Home guard: a home read must resolve its home replica, never a mount.
    if (space === this.homeSpace) return undefined;
    return this.#mounts.get(`${space}\0${id}`);
  }
}

describe("C3.13 served foreign-read value carriage (loadRoot seam)", () => {
  let home: Identity;
  let HOME: MemorySpace;
  let FOREIGN: MemorySpace;
  let storage: MountEmulatedStorageManager;

  beforeEach(async () => {
    home = await Identity.generate({ implementation: "noble" });
    HOME = home.did();
    FOREIGN = (await Identity.generate({ implementation: "noble" })).did();
    storage = MountEmulatedStorageManager.emulate({
      as: home,
    }) as MountEmulatedStorageManager;
    storage.homeSpace = HOME;
  });

  afterEach(async () => {
    await storage.close().catch(() => undefined);
  });

  // (i) A served mount entry hydrates the cross-space read with its VALUE.
  // RED before the loadRoot consult: the empty FOREIGN home replica folds
  // `undefined` (→ Default<0> in a real derivation).
  it("reads the served foreign VALUE from the mount, not the empty replica", () => {
    storage.setMount(FOREIGN, FOREIGN_DOC, { value: 41 } as EntityDocument);
    const tx = storage.edit();
    const read = tx.read({
      space: FOREIGN,
      id: FOREIGN_DOC,
      type: HOME_TYPE,
      path: ["value"],
    });
    expect(read.error).toBeUndefined();
    expect(read.ok?.value).toBe(41);
    tx.abort();
  });

  // (ii) A home-write + foreign-read commit succeeds — the validate()-skip is
  // LOAD-BEARING. The mount hands `initial.value = { value: 41 }`, but the
  // FOREIGN home replica is empty, so without the skip validate()'s claim()
  // compares 41 vs undefined and throws StateInconsistency.
  it("commits a home write alongside a mount-served foreign read (no StateInconsistency)", async () => {
    storage.setMount(FOREIGN, FOREIGN_DOC, { value: 41 } as EntityDocument);
    const tx = storage.edit();

    const fr = tx.read({
      space: FOREIGN,
      id: FOREIGN_DOC,
      type: HOME_TYPE,
      path: ["value"],
    });
    expect(fr.ok?.value).toBe(41);

    const w = tx.write(
      { space: HOME, id: HOME_DOC, type: HOME_TYPE, path: [] },
      { value: 7 },
    );
    expect(w.error).toBeUndefined();

    const committed = await tx.commit();
    expect(committed.error).toBeUndefined();
  });

  // (iii) With NO mount entry, a home read is byte-identical to pre-C3.13:
  // `foreignReadDocument` returns undefined and the normal replica read runs.
  it("falls through to the replica read when no mount entry exists", async () => {
    // Persist a home doc through a genuine commit.
    {
      const setup = storage.edit();
      const w = setup.write(
        { space: HOME, id: HOME_DOC, type: HOME_TYPE, path: [] },
        { value: 99 },
      );
      expect(w.error).toBeUndefined();
      expect((await setup.commit()).error).toBeUndefined();
    }
    await storage.synced();

    storage.clearMounts();
    const tx = storage.edit();
    const read = tx.read({
      space: HOME,
      id: HOME_DOC,
      type: HOME_TYPE,
      path: ["value"],
    });
    expect(read.error).toBeUndefined();
    expect(read.ok?.value).toBe(99);
    tx.abort();
  });

  // (iv) An entry whose `document` is null is AUTHORITATIVELY ABSENT (D4/D5):
  // the read is served (mountServed) with an undefined value and NO error/crash
  // — this guards the `entry.document ?? undefined` null branch (passing a bare
  // null to toTransactionDocumentValue would throw on Object.keys(null)).
  it("serves an authoritative-absent (document: null) mount entry as undefined", async () => {
    storage.setMount(FOREIGN, FOREIGN_DOC, null);
    const tx = storage.edit();
    const read = tx.read({
      space: FOREIGN,
      id: FOREIGN_DOC,
      type: HOME_TYPE,
      path: [],
    });
    expect(read.error).toBeUndefined();
    expect(read.ok?.value).toBeUndefined();

    // The served-absent read still rides a commit with a home write (the
    // mountServed skip applies just as for a valued entry).
    const w = tx.write(
      { space: HOME, id: HOME_DOC, type: HOME_TYPE, path: [] },
      { value: 7 },
    );
    expect(w.error).toBeUndefined();
    expect((await tx.commit()).error).toBeUndefined();
  });
});
