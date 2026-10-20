import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { entityKey } from "../src/scheduler/keys.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

// A start made for a holder gives the result a lifetime the holder can give
// up (`docs/specs/runner-child-run-ownership.md`, "Held lifetimes"). Each case
// drives the public API: a piece, the holders that start it, and the order of
// starts, launches, releases and stops that tells the cases apart.

const signer = await Identity.fromPassphrase("held start lifetime");
const space = signer.did();

describe("held start lifetimes", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  function running(cell: Cell<unknown>): boolean {
    return runtime.runner.cancels.has(
      entityKey(cell.getAsNormalizedFullLink(), runtime.scopeKeyIdentity),
    );
  }

  // A piece that is set up and stored but not running, as one a client opens
  // from storage is.
  function piecePattern() {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    return pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
  }

  async function storedPiece(name: string): Promise<Cell<unknown>> {
    const Piece = piecePattern();
    const tx = runtime.edit();
    const piece = runtime.getCell(space, name, undefined, tx);
    runtime.run(tx, Piece, { value: 3 }, piece);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    runtime.runner.stop(piece);
    expect(running(piece)).toBe(false);
    return piece;
  }

  // A parent whose result holds a nested child, running, and that child.
  async function parentWithChild(name: string) {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Child = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const Parent = pattern<{ value: number }>(({ value }) => ({
      child: Child({ value }),
    }));
    const tx = runtime.edit();
    const parent = runtime.getCell<{ child: { doubled: number } }>(
      space,
      name,
      undefined,
      tx,
    );
    const result = runtime.run(tx, Parent, { value: 3 }, parent);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    expect(await result.pull()).toEqual({ child: { doubled: 6 } });
    const child = result.key("child").resolveAsCell() as Cell<unknown>;
    expect(running(child)).toBe(true);
    return {
      parent,
      child,
      rerun: () => runtime.run(undefined, Parent, { value: 3 }, parent),
    };
  }

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

  it("runs while any holder holds it and stops when the last lets go", async () => {
    const piece = await storedPiece("held by two");
    const first = {};
    const second = {};

    await expect(runtime.start(piece, { holder: first })).resolves.toBe(true);
    await expect(runtime.start(piece, { holder: second })).resolves.toBe(true);

    expect(runtime.releaseHold(piece, first)).toBe(true);
    expect(running(piece)).toBe(true);
    expect(runtime.releaseHold(piece, second)).toBe(true);
    expect(running(piece)).toBe(false);
  });

  it("starts again for a holder after its last holder let go", async () => {
    const piece = await storedPiece("held again");
    const holder = {};
    await runtime.start(piece, { holder });
    runtime.releaseHold(piece, holder);
    expect(running(piece)).toBe(false);

    await expect(runtime.start(piece, { holder })).resolves.toBe(true);
    expect(running(piece)).toBe(true);
    runtime.releaseHold(piece, holder);
    expect(running(piece)).toBe(false);
  });

  it("gives up every hold of one holder and no other holder's", async () => {
    const one = await storedPiece("holder's first");
    const two = await storedPiece("holder's second");
    const leaving = {};
    const staying = {};
    await runtime.start(one, { holder: leaving });
    await runtime.start(two, { holder: leaving });
    await runtime.start(two, { holder: staying });

    runtime.releaseAllHolds(leaving);
    expect(running(one)).toBe(false);
    expect(running(two)).toBe(true);
    expect(runtime.releaseHold(two, leaving)).toBe(false);
    runtime.releaseHold(two, staying);
    expect(running(two)).toBe(false);
  });

  it("leaves a piece started without a holder running", async () => {
    const piece = await storedPiece("also started for good");
    const holder = {};
    await runtime.start(piece, { holder });
    await runtime.start(piece);

    runtime.releaseHold(piece, holder);
    expect(running(piece)).toBe(true);
    runtime.runner.stop(piece);
  });

  it("leaves a permanent start that joined a held one permanent", async () => {
    const piece = await storedPiece("joined for good");
    const holder = {};
    const held = runtime.start(piece, { holder });
    const permanent = runtime.start(piece);
    await expect(held).resolves.toBe(true);
    await expect(permanent).resolves.toBe(true);

    runtime.releaseHold(piece, holder);
    expect(running(piece)).toBe(true);
    runtime.runner.stop(piece);
  });

  it("leaves a piece that was already running when held", async () => {
    const piece = await storedPiece("running before its holder");
    await runtime.start(piece);
    const holder = {};
    await runtime.start(piece, { holder });

    expect(runtime.releaseHold(piece, holder)).toBe(true);
    expect(running(piece)).toBe(true);
    runtime.runner.stop(piece);
  });

  it("keeps a held child running after its parent stops, until released", async () => {
    const { parent, child } = await parentWithChild("parent of a held child");
    const holder = {};
    await expect(runtime.start(child, { holder })).resolves.toBe(true);

    runtime.runner.stop(parent);
    expect(running(child)).toBe(true);
    runtime.releaseHold(child, holder);
    expect(running(child)).toBe(false);
  });

  it("leaves a held child its running parent still launches", async () => {
    const { parent, child } = await parentWithChild("parent still running");
    const holder = {};
    await runtime.start(child, { holder });

    runtime.releaseHold(child, holder);
    expect(running(child)).toBe(true);
    expect(running(parent)).toBe(true);
  });

  it("leaves a held piece a launch named after the hold", async () => {
    const { parent, child, rerun } = await parentWithChild(
      "parent launched after the hold",
    );
    runtime.runner.stop(parent);
    expect(running(child)).toBe(false);
    const holder = {};
    await runtime.start(child, { holder });

    rerun();
    await runtime.idle();
    expect(running(parent)).toBe(true);

    runtime.releaseHold(child, holder);
    expect(running(child)).toBe(true);
    runtime.runner.stop(parent);
    expect(running(child)).toBe(false);
  });

  it("leaves a held piece its parent resumed after the hold", async () => {
    const { parent, child } = await parentWithChild(
      "parent resumed after the hold",
    );
    runtime.runner.stop(parent);
    const holder = {};
    await runtime.start(child, { holder });

    await runtime.start(parent);
    await runtime.idle();

    runtime.releaseHold(child, holder);
    expect(running(child)).toBe(true);
    runtime.runner.stop(parent);
    expect(running(child)).toBe(false);
  });

  it("leaves a held piece that a synced run named after the hold", async () => {
    const piece = await storedPiece("run synced after the hold");
    const holder = {};
    await runtime.start(piece, { holder });

    await runtime.runSynced(piece, piecePattern(), { value: 3 });

    runtime.releaseHold(piece, holder);
    expect(running(piece)).toBe(true);
    runtime.runner.stop(piece);
  });

  it("hands a release that a start in flight declines to that start", async () => {
    const piece = await storedPiece("released while another start resolves");
    const first = {};
    const second = {};
    await runtime.start(piece, { holder: first });

    const opening = runtime.start(piece, { holder: second });
    runtime.releaseHold(piece, first);
    await expect(opening).resolves.toBe(true);
    expect(running(piece)).toBe(true);

    runtime.releaseHold(piece, second);
    expect(running(piece)).toBe(false);
  });

  it("leaves a held child that its parent named while the start settled", async () => {
    const { parent, child, rerun } = await parentWithChild(
      "parent launched while the hold settles",
    );
    runtime.runner.stop(parent);
    const holder = {};
    const opening = runtime.start(child, { holder });
    rerun();
    await expect(opening).resolves.toBe(true);
    await runtime.idle();
    expect(running(parent)).toBe(true);

    runtime.releaseHold(child, holder);
    expect(running(child)).toBe(true);
    runtime.runner.stop(parent);
  });

  it("discards held lifetimes on an explicit stop", async () => {
    const piece = await storedPiece("stopped while held");
    const holder = {};
    await runtime.start(piece, { holder });
    runtime.runner.stop(piece);

    expect(runtime.releaseHold(piece, holder)).toBe(false);
    await runtime.start(piece);
    expect(running(piece)).toBe(true);
    runtime.runner.stop(piece);
  });

  it("answers that a holder that holds nothing gave nothing up", async () => {
    const piece = await storedPiece("never held");
    expect(runtime.releaseHold(piece, {})).toBe(false);
    runtime.releaseAllHolds({});
    expect(running(piece)).toBe(false);
  });
});
