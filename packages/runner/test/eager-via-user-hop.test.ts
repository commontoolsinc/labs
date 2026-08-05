// Server-execution v2 stage F: the eager via-user hop (scopes.md §2's
// MUST, flag-gated). A space→session narrowing writes CHAINED redirects
// — space→user→session, ALWAYS via user, even when discovery or the
// declaration jumps straight to session — so every chain has the one
// uniform shape and a later user-level reader finds a well-formed user
// link to follow. This deliberately DIFFERS from main's one-hop-per-event
// behavior, so the OFF arm is pinned here too: off the flag, a
// space→session narrowing keeps writing exactly ONE hop.

import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { createCell } from "../src/cell.ts";
import { parseLink } from "../src/link-utils.ts";

const signer = await Identity.fromPassphrase("eager via-user hop test");
const space = signer.did() as MemorySpace;

const SESSION_SCOPED_SCHEMA = {
  type: "object",
  properties: {
    draft: {
      type: "object",
      properties: { text: { type: "string" } },
      asCell: [{ kind: "cell", scope: "session" }],
    },
  },
} as const;

const run = async (
  serverExecution: boolean,
  probe: (runtime: Runtime) => Promise<void>,
) => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    experimental: { serverExecution },
  });
  try {
    await probe(runtime);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

Deno.test("flag ON: a space→session narrowing writes the chained space→user→session redirects", async () => {
  await run(true, async (runtime) => {
    const tx = runtime.edit();
    const cell = runtime.getCell(
      space,
      "via-user-hop-on",
      SESSION_SCOPED_SCHEMA,
      tx,
    );
    cell.set({ draft: { text: "hello" } } as never);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();

    const baseLink = cell.key("draft").getAsNormalizedFullLink();
    const schemaless = createCell<{ draft: { text: string } }>(
      runtime,
      { ...cell.getAsNormalizedFullLink(), schema: undefined },
    );

    // The space slot holds a link to the USER instance (the eager hop) —
    // not straight to session.
    const spaceSlot = parseLink(
      schemaless.key("draft").getRaw({ lastNode: "writeRedirect" }),
      schemaless.key("draft"),
    );
    assertEquals(spaceSlot?.scope, "user");
    assertEquals(spaceSlot?.id, baseLink.id);

    // The user instance holds a link to the SESSION instance.
    const userInstance = createCell<{ text: string }>(
      runtime,
      { ...baseLink, schema: undefined, scope: "user" },
    );
    const userSlot = parseLink(
      userInstance.getRaw({ lastNode: "writeRedirect" }),
      userInstance,
    );
    assertEquals(userSlot?.scope, "session");
    assertEquals(userSlot?.id, baseLink.id);

    // The value lives at the session instance.
    const sessionInstance = createCell<{ text: string }>(
      runtime,
      { ...baseLink, schema: undefined, scope: "session" },
    );
    assertEquals(sessionInstance.getRaw(), { text: "hello" });

    // Reading through the chain from the broad slot resolves the value.
    assertEquals(cell.key("draft").key("text").get() as unknown, "hello");
  });
});

Deno.test("flag OFF: the same narrowing keeps today's ONE hop (space slot links straight to session)", async () => {
  await run(false, async (runtime) => {
    const tx = runtime.edit();
    const cell = runtime.getCell(
      space,
      "via-user-hop-off",
      SESSION_SCOPED_SCHEMA,
      tx,
    );
    cell.set({ draft: { text: "hello" } } as never);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();

    const baseLink = cell.key("draft").getAsNormalizedFullLink();
    const schemaless = createCell<{ draft: { text: string } }>(
      runtime,
      { ...cell.getAsNormalizedFullLink(), schema: undefined },
    );
    const spaceSlot = parseLink(
      schemaless.key("draft").getRaw({ lastNode: "writeRedirect" }),
      schemaless.key("draft"),
    );
    // Today's behavior, byte for byte: one hop, straight to session.
    assertEquals(spaceSlot?.scope, "session");
    // And no user-level link exists.
    const userInstance = createCell<{ text: string }>(
      runtime,
      { ...baseLink, schema: undefined, scope: "user" },
    );
    assertEquals(userInstance.getRaw(), undefined);
  });
});

Deno.test("flag ON: an OMITTED session-scoped property gets the chained eager redirects", async () => {
  await run(true, async (runtime) => {
    const tx = runtime.edit();
    const cell = runtime.getCell(
      space,
      "via-user-hop-eager-on",
      {
        type: "object",
        properties: {
          draft: {
            type: "object",
            properties: { text: { type: "string" } },
            asCell: [{ kind: "cell", scope: "session" }],
          },
          title: { type: "string" },
        },
      } as const,
      tx,
    );
    // Omit the scoped property entirely: the eager path materializes the
    // redirect chain with no content write.
    cell.set({ title: "hello" } as never);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();

    const baseLink = cell.key("draft").getAsNormalizedFullLink();
    const schemaless = createCell<{ draft: { text: string } }>(
      runtime,
      { ...cell.getAsNormalizedFullLink(), schema: undefined },
    );
    const spaceSlot = parseLink(
      schemaless.key("draft").getRaw({ lastNode: "writeRedirect" }),
      schemaless.key("draft"),
    );
    assertEquals(spaceSlot?.scope, "user");
    const userInstance = createCell<{ text: string }>(
      runtime,
      { ...baseLink, schema: undefined, scope: "user" },
    );
    const userSlot = parseLink(
      userInstance.getRaw({ lastNode: "writeRedirect" }),
      userInstance,
    );
    assertEquals(userSlot?.scope, "session");
  });
});
