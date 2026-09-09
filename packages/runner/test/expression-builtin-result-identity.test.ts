// The result store an expression builtin (`ifElse`, `when`, `unless`) mints
// is named by the spot it fills, not by what fills it. The store's id is what
// every runtime sharing the piece writes into the node's output spot, so an
// id that moved with the inputs' serialization was a store two runtimes could
// disagree on — and two runtimes disagreeing on one shared spot rewrite it
// against each other for as long as both run. That storm ran on the Topics
// board's profile badge across the 2026-09-03 deploy: the badge is an `ifElse`
// over a per-user condition, and clients on the two vintages serialized the
// node's inputs differently.
//
// A pattern edit that changes only a branch literal stands in for that
// vintage change here: the inputs document moves, the output spot does not.

import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { assertThrows } from "@std/assert";
import type { NodeFactory } from "../src/builder/types.ts";
import { ownedResultCause } from "../src/builtins/scope-policy.ts";
import { type Cell, createCell } from "../src/cell.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

type Builder = ReturnType<typeof createTrustedBuilder>["commonfabric"];
type Root = NodeFactory<{ condition: boolean }, { value: unknown }>;

/**
 * Runs `first` into a fresh piece over a user-scoped `condition`, then edits
 * the piece to `second`, and returns the link stored in the `value` spot after
 * each run together with the value it resolved to.
 */
async function acrossEdit(
  op: string,
  condition: boolean,
  build: (builder: Builder) => { first: Root; second: Root },
) {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();
  try {
    const { first, second } = build(createTrustedBuilder(runtime).commonfabric);
    const conditionBase = runtime.getCell<boolean>(
      space,
      `${op} result identity condition`,
      undefined,
      tx,
    );
    const conditionCell = createCell<boolean>(
      runtime,
      { ...conditionBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    conditionCell.set(condition);
    const resultCell = runtime.getCell<{ value: unknown }>(
      space,
      `${op} result identity`,
      undefined,
      tx,
    );
    const stored = (result: Cell<{ value: unknown }>) => {
      const link = parseLink(
        result.key("value").getRaw({ lastNode: "writeRedirect" }),
        result,
      );
      return {
        id: link?.id,
        scope: link?.scope,
        value: result.key("value").get(),
      };
    };

    const result = runtime.run(
      tx,
      first,
      { condition: conditionCell },
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();
    const before = stored(result);

    const editTx = runtime.edit();
    const edited = runtime.run(
      editTx,
      second,
      { condition: conditionCell },
      resultCell,
    );
    runtime.prepareTxForCommit(editTx);
    await editTx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await edited.pull();
    const after = stored(edited);
    return { before, after };
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

Deno.test("ifElse keeps its result store across an edit of its branches", async () => {
  const { before, after } = await acrossEdit(
    "ifElse",
    true,
    ({ ifElse, pattern }) => ({
      first: pattern<{ condition: boolean }>(({ condition }) => ({
        value: ifElse(condition, "left-1", "right-1"),
      })),
      second: pattern<{ condition: boolean }>(({ condition }) => ({
        value: ifElse(condition, "left-2", "right-2"),
      })),
    }),
  );
  assertEquals(before.value, "left-1");
  assertEquals(after.value, "left-2");
  // The store follows the condition's scope (scoped-cell-instances.md) …
  assertEquals(before.scope, "user");
  assertEquals(after.scope, "user");
  // … and the shared spot names the same store before and after the edit.
  assertEquals(after.id, before.id);
});

Deno.test("when keeps its result store across an edit of its value", async () => {
  const { before, after } = await acrossEdit(
    "when",
    true,
    ({ when, pattern }) => ({
      first: pattern<{ condition: boolean }>(({ condition }) => ({
        value: when(condition, "value-1"),
      })),
      second: pattern<{ condition: boolean }>(({ condition }) => ({
        value: when(condition, "value-2"),
      })),
    }),
  );
  assertEquals(before.value, "value-1");
  assertEquals(after.value, "value-2");
  assertEquals(before.scope, "user");
  assertEquals(after.id, before.id);
});

Deno.test("unless keeps its result store across an edit of its fallback", async () => {
  const { before, after } = await acrossEdit(
    "unless",
    false,
    ({ unless, pattern }) => ({
      first: pattern<{ condition: boolean }>(({ condition }) => ({
        value: unless(condition, "fallback-1"),
      })),
      second: pattern<{ condition: boolean }>(({ condition }) => ({
        value: unless(condition, "fallback-2"),
      })),
    }),
  );
  assertEquals(before.value, "fallback-1");
  assertEquals(after.value, "fallback-2");
  assertEquals(before.scope, "user");
  assertEquals(after.id, before.id);
});

Deno.test("an expression builtin with no output spot has no store to name", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const piece = runtime.getCell(space, "no output spot");
    const inputs = runtime.getImmutableCell(space, { condition: true });
    // A node whose output binding reaches no write redirect: nothing reads
    // the spot, so nothing can name the store every runtime must share.
    assertThrows(
      () =>
        ownedResultCause("ifElse", {
          inputs,
          parents: piece.entityId,
        }, piece),
      Error,
      "ifElse: result store requires a write-redirect output binding",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
