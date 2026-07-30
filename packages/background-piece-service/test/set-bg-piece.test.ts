// `setBGPiece()` against a real `Runtime`, because the thing worth testing is
// transactional: registering the same (`space`, `pieceId`) pair twice must land
// on one entry. The fakes in `service-modules.test.ts` cannot show that -- their
// `withTx()` is the identity function and their `editWithRetry()` calls its
// callback once and never conflicts -- so they exercise the shape of the calls
// without their semantics.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { getBGPieces, setBGPiece } from "../src/utils.ts";

const signer = await Identity.fromPassphrase("bg piece test operator");
const bgSpace = signer.did();

const TEST_DID = "did:key:z6Mktestspace";
const PIECE_ID = `fid1:${"a".repeat(54)}`;
const OTHER_PIECE_ID = `fid1:${"b".repeat(54)}`;

describe("setBGPiece() registration is an upsert", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let bgCause: string;
  let causeCounter = 0;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "disabled",
    });
    // A distinct cause per test, so one test's registrations cannot be read by
    // the next.
    bgCause = `bg-upsert-test-${causeCounter++}`;
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** Registers one piece, returning whether it was newly added. */
  function register(pieceId: string, integration = "gmail"): Promise<boolean> {
    return setBGPiece({
      space: TEST_DID,
      pieceId,
      integration,
      runtime,
      bgSpace,
      bgCause,
    });
  }

  /** The currently registered entries, read back through a fresh cell. */
  async function readEntries() {
    const cell = await getBGPieces({ bgSpace, bgCause, runtime });
    return (cell.get() ?? []).map((entry) => entry.get());
  }

  it("adds an entry the first time a piece is registered", async () => {
    assertEquals(await register(PIECE_ID), true);

    const entries = await readEntries();
    assertEquals(entries.length, 1);
    assertEquals(entries[0]!.space, TEST_DID);
    assertEquals(entries[0]!.pieceId, PIECE_ID);
    assertEquals(entries[0]!.status, "Initializing");
  });

  it("re-enables rather than duplicating on a second registration", async () => {
    // This is the acceptance criterion: an OAuth callback fires on every
    // (re)connection, so the same pair arrives repeatedly.
    assertEquals(await register(PIECE_ID), true);
    assertEquals(await register(PIECE_ID), false);

    const entries = await readEntries();
    assertEquals(entries.length, 1);
    assertEquals(entries[0]!.status, "Re-initializing");
    assertEquals(entries[0]!.disabledAt, 0);
  });

  it("keeps one entry across several re-registrations", async () => {
    await register(PIECE_ID);
    await register(PIECE_ID);
    await register(PIECE_ID);

    assertEquals((await readEntries()).length, 1);
  });

  it("keeps distinct pieces as separate entries", async () => {
    assertEquals(await register(PIECE_ID), true);
    assertEquals(await register(OTHER_PIECE_ID), true);

    const entries = await readEntries();
    assertEquals(entries.length, 2);
    assertEquals(
      entries.map((e) => e.pieceId).sort(),
      [PIECE_ID, OTHER_PIECE_ID].sort(),
    );
  });

  it("lands one entry when the same piece is registered concurrently", async () => {
    // NOTE: this pins the outcome, not the mechanism. In practice the two calls
    // serialize -- each awaits `getBGPieces()` and its sync before touching the
    // list, so the first commits before the second reads -- and the assertions
    // below therefore also hold for a version that reads outside the
    // transaction. Verified by running them against exactly that. Provoking a
    // real commit conflict would take driving the read and write phases apart,
    // which this function does not expose. Kept because the outcome is the
    // acceptance criterion, but it is not evidence that the conflict path works.
    const results = await Promise.all([
      register(PIECE_ID),
      register(PIECE_ID),
    ]);

    assertEquals((await readEntries()).length, 1);
    // Exactly one call may claim to have added it.
    assertEquals(results.filter((added) => added).length, 1);
  });
});
