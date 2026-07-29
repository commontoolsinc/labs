import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { firstResolvedOutputRedirect } from "../src/runner.ts";

// Seen live on estuary home spaces (2026-07-29): a sub-pattern node whose
// stored outputs carry a DEFERRED partialCause alias unwraps to a bare
// `{"$alias":{"partialCause":…}}` record, which parseAliasBinding refuses by
// design — and the resume walk's catch then skipped the WHOLE node's
// owned-cell pre-sync ("resume-owned-cells skipping a sub-pattern node whose
// outputs did not bind or resolve"), silently re-exposing the cold-cache
// commit-revert race the pre-sync exists to prevent. A partialCause alias is
// a derived internal cell, never the node's reserved result spot: the scan
// must skip the entry and keep looking, not abandon the node.

const signer = await Identity.fromPassphrase("resume-output-partialcause");
const space = signer.did();

describe("firstResolvedOutputRedirect vs partialCause aliases", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let rt: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });
  afterEach(async () => {
    await rt?.dispose();
    await storageManager?.close();
  });

  const partialCauseAlias = {
    $alias: {
      partialCause: { "$generated": 0 },
      path: [],
      scope: "space",
    },
  };

  it("skips a partialCause alias and still finds the result spot after it", () => {
    const tx = rt.edit();
    const base = rt.getCell<Record<string, unknown>>(
      space,
      "partialcause-scan-base",
      undefined,
      tx,
    );
    const spot = rt.getCell<Record<string, unknown>>(
      space,
      "partialcause-scan-spot",
      undefined,
      tx,
    );
    const outputs = {
      // The exact shape from the estuary logs — listed FIRST so the scan
      // meets it before the real spot.
      generated: partialCauseAlias,
      result: spot.getAsWriteRedirectLink({ base }),
    };

    const found = firstResolvedOutputRedirect(rt, tx, outputs, base);
    tx.abort("test: read-only");
    expect(found?.id).toBe(spot.getAsNormalizedFullLink().id);
  });

  it("returns undefined (not a throw) when outputs hold ONLY such aliases", () => {
    const tx = rt.edit();
    const base = rt.getCell<Record<string, unknown>>(
      space,
      "partialcause-only-base",
      undefined,
      tx,
    );
    const found = firstResolvedOutputRedirect(
      rt,
      tx,
      { generated: partialCauseAlias },
      base,
    );
    tx.abort("test: read-only");
    expect(found).toBeUndefined();
  });
});
