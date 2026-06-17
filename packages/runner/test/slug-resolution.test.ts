import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { parseLink } from "../src/link-utils.ts";
import { slugIdForSpace } from "../src/slugs.ts";
import { entityIdFrom } from "../src/create-ref.ts";
import {
  parseSlugRedirect,
  resolveSlugTargetCell,
} from "../src/slug-resolution.ts";

const signer = await Identity.fromPassphrase("runner slug resolution tests");
const space = signer.did();

describe("slug resolution", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("resolves slug redirects to arbitrary cells", async () => {
    const target = runtime.getCell(
      space,
      { space, random: "slug-cell-target" },
    );
    const slugCell = runtime.getCellFromEntityId(
      space,
      entityIdFrom(slugIdForSpace(space, "value-link")),
    );

    await runtime.editWithRetry((tx) => {
      const targetWithTx = target.withTx(tx);
      const slugWithTx = slugCell.withTx(tx);
      targetWithTx.set({ value: 1 });
      slugWithTx.setRawUntyped(
        targetWithTx.getAsWriteRedirectLink({ base: slugWithTx }),
      );
    });

    await slugCell.sync();
    const link = parseLink(slugCell.getRaw(), slugCell);
    expect(link?.overwrite).toBe("redirect");

    const resolved = await resolveSlugTargetCell(runtime, space, "value-link");
    expect(resolved.getAsNormalizedFullLink().id).toBe(
      target.getAsNormalizedFullLink().id,
    );
    expect(resolved.getAsNormalizedFullLink().path).toEqual([]);
    expect(resolved.get()).toEqual({ value: 1 });
  });

  it("reports missing and malformed slug documents", async () => {
    await expect(
      resolveSlugTargetCell(runtime, space, "missing"),
    ).rejects.toThrow(/Slug "missing" not found/);

    const slugCell = runtime.getCellFromEntityId(
      space,
      entityIdFrom(slugIdForSpace(space, "malformed")),
    );
    await runtime.editWithRetry((tx) => {
      slugCell.withTx(tx).setRawUntyped("not a redirect");
    });

    await expect(
      resolveSlugTargetCell(runtime, space, "malformed"),
    ).rejects.toThrow(/does not contain a valid redirect/);
  });

  it("treats parseLink throws as malformed redirects (foreign-written payloads)", () => {
    // A sigil-SHAPED payload with broken internals (non-array path) makes
    // parseLink throw a generic TypeError. This runtime's own write path
    // rejects such values, but foreign clients can persist them over the
    // memory protocol — the resolver must fold the throw into the typed
    // "malformed" outcome (SlugResolutionError) instead of leaking a bare
    // TypeError past callers like the fabric chase's chain wrapping.
    const base = runtime.getCellFromEntityId(
      space,
      entityIdFrom(slugIdForSpace(space, "poisoned")),
    );
    const poisoned = {
      "/": {
        "link@1": { id: "of:abc", path: "not-an-array", overwrite: "redirect" },
      },
    };
    expect(() => parseLink(poisoned, base)).toThrow(); // the hazard is real
    expect(parseSlugRedirect(poisoned, base)).toBeUndefined();
    expect(
      parseSlugRedirect("not a redirect", base),
    ).toBeUndefined();
  });
});
