import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { enrollRuntimeOwnedStore } from "../src/builtins/runtime-owned-store.ts";
import { runtimeWritePolicyAuthorization } from "../src/cfc/types.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("runtime owned store wiring");
const space = signer.did();
const elsewhere =
  (await Identity.fromPassphrase("runtime owned store elsewhere")).did();

/**
 * That the runner enrolls a running piece's own stores, that a builtin
 * enrolls the state stores it mints, and that both go when the piece stops.
 *
 * `cfc-writer-fit.test.ts` states the RULE against a hand-recorded marker.
 * These run a real piece, so they cover the wiring the rule rests on: which
 * transaction names the stores, and when the enrollment ends. A hand-recorded
 * marker cannot tell whether `startCore` registered anything at all.
 */
describe("runtime-owned-store enrollment wiring", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /**
   * A source whose `secret` field carries `clause`. Each write wants its own:
   * a route-2 upgrade declares what it carried, so a second write reusing the
   * first's clause would fit the store's own declaration whatever the
   * enrollment says.
   */
  const seedSecret = async (name: string, clause = name) => {
    const seed = runtime.edit();
    const cell = runtime.getCell(space, name, {
      type: "object",
      properties: { secret: { type: "string" } },
    } as JSONSchema);
    const id = cell.getAsNormalizedFullLink().id;
    writeSeedEnvelopeDoc(seed, space);
    seed.writeOrThrow({ space, scope: "space", id, path: [] }, {
      value: { secret: "s3cr3t" },
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: ["secret"],
            label: { confidentiality: [clause] },
          }],
        },
      },
      // deno-lint-ignore no-explicit-any
    } as any);
    expect((await seed.commit()).ok).toBeDefined();
  };

  /** Start a piece holding a list of its own, and hand back that list. */
  const startPiece = async (name: string) => {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, Cell: BuilderCell } = commonfabric;
    const testPattern = pattern<Record<string, never>>(() => ({
      notes: BuilderCell.of<string[]>([]),
    }));
    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      space,
      name,
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();
    return { result, resultCell };
  };

  /**
   * Append what the seeded source carries to the piece's own list, on a fresh
   * transaction that names no store — the shape a reactive update has.
   */
  const appendSecret = async (
    result: Awaited<ReturnType<typeof startPiece>>["result"],
    sourceName: string,
    suffix: string,
  ) => {
    const tx = runtime.edit();
    tx.setCfcEnforcementMode("enforce-strict");
    const source = runtime.getCell(space, sourceName, undefined, tx);
    const raw = source.getRaw() as { secret?: string };
    // deno-lint-ignore no-explicit-any
    (result.withTx(tx) as any).key("notes").set([`${raw.secret}/${suffix}`]);
    tx.prepareCfc();
    return await tx.commit();
  };

  it("enrolls a running piece's stores, so a later write declares", async () => {
    // The write runs on a transaction of its own, which names nothing: the
    // enrollment the instantiation made is the whole of what reaches it.
    await seedSecret("wiring-append-source");
    const { result } = await startPiece("wiring-append");

    expect((await appendSecret(result, "wiring-append-source", "first")).error)
      .toBeUndefined();
  });

  it("declares on the piece's own result document", async () => {
    // The result document is on the route and the others are not enough to
    // put it there: a nested piece's result is `{resultFor}`, minted from a
    // node's cause, and the reactive update that first carried a label into
    // one is half of what this change exists for. It is also the member whose
    // paths an author CAN declare, so where a schema does, the route declines
    // and the misfit stands.
    await seedSecret("wiring-result-source");
    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, Cell: BuilderCell } = commonfabric;
    const testPattern = pattern<Record<string, never>>(() => ({
      note: BuilderCell.of(""),
    }));
    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      space,
      "wiring-result",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();

    // A later transaction naming no store, writing a labeled value into the
    // result DOCUMENT — addressed without the pattern's schema, at a path
    // that projects to no internal cell, so the write lands there and not in
    // something the manifest already covers.
    void result;
    const write = runtime.edit();
    write.setCfcEnforcementMode("enforce-strict");
    const source = runtime.getCell(
      space,
      "wiring-result-source",
      undefined,
      write,
    );
    const raw = source.getRaw() as { secret?: string };
    const document = runtime.getCell<{ scratch?: string }>(
      space,
      "wiring-result",
      undefined,
      write,
    );
    document.key("scratch").set(`${raw.secret}!`);
    write.prepareCfc();
    expect((await write.commit()).error).toBeUndefined();
  });

  it("enrolls no store a builtin minted outside the owner's space", () => {
    // A store elsewhere belongs to whoever holds that space's replicas, so a
    // policy declared on it out of this piece's flow join would put another
    // space's bytes behind a promise made here. The helper every builtin
    // holding state goes through is where that is settled, because the
    // enrollment key names an owner and a store outside the space has none.
    const tx = runtime.edit();
    const owner = runtime.getCell(space, "cross-space-owner", undefined, tx);
    const here = runtime.getCell(space, "cross-space-here", undefined, tx);
    const there = runtime.getCell(
      elsewhere,
      "cross-space-there",
      undefined,
      tx,
    );

    enrollRuntimeOwnedStore(tx, owner, here);
    enrollRuntimeOwnedStore(tx, owner, there);

    expect(
      tx.isRuntimeOwnedStore(
        space,
        here.getAsNormalizedFullLink().id,
        runtimeWritePolicyAuthorization,
      ),
    ).toBe(true);
    expect(
      tx.isRuntimeOwnedStore(
        elsewhere,
        there.getAsNormalizedFullLink().id,
        runtimeWritePolicyAuthorization,
      ),
    ).toBe(false);
    tx.abort("done");
  });

  it("lets them go when the piece stops", async () => {
    // Nothing may keep an enrollment alive past its piece: a list operation
    // mints one piece per element, so an enrollment that outlived its piece
    // would grow with every element a churning list ever held.
    await seedSecret("wiring-release-source");
    const { result, resultCell } = await startPiece("wiring-release");
    expect((await appendSecret(result, "wiring-release-source", "first")).error)
      .toBeUndefined();

    runtime.runner.stop(resultCell);

    // A clause the store's own declaration does not already cover, so the
    // route is what the write needs and the release is what took it away.
    await seedSecret("wiring-release-other");
    const refused = await appendSecret(
      result,
      "wiring-release-other",
      "second",
    );
    expect(refused.error?.message).toContain(
      "writer-fit confidentiality misfit",
    );
  });
});
