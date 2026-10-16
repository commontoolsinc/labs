/**
 * What a FabriChat room's `sendMessage` answers, read from each send's own
 * receipt: the message it sent, and, for a send repeating a `requestId` the
 * sender sent under before, the message the first one sent, though other
 * sends came between. A pattern test drives a stream through its steps, and
 * its harness hands no step's result back, so this reads the receipts against
 * a runtime and storage of the test's own; `../fabrichat/send-requests.test.tsx`
 * covers what each send adds to the room.
 */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import {
  type Cell,
  type IExtendedStorageTransaction,
  type JSONSchema,
  Runtime,
  sendEvent,
} from "@commonfabric/runner";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "@commonfabric/runner/cfc";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

const signer = await Identity.fromPassphrase("fabrichat-send-requests");
const home = signer.did();

// The patterns package, which the room's imports reach across.
const PATTERNS = fromFileUrl(new URL("..", import.meta.url));

/** A room bound to a viewer's profile, which a pattern test can't supply. */
const ROOM_PATH = fromFileUrl(
  new URL("./fixtures/fabrichat-private-catalog/main.tsx", import.meta.url),
);

/** Sends `text` to `room`'s `sendMessage` as its composer's control would. */
function sendTo(
  room: Cell<unknown>,
  text: string,
  requestId: string,
): Promise<IExtendedStorageTransaction> {
  const event = {
    requestId,
    body: text,
    provenance: reviewedActionProvenance("dom", {
      surface: "ChatSendSurface",
      action: "ChatSend",
    }),
  };
  markRendererTrustedEvent(event);
  return new Promise((resolve) => {
    sendEvent(room.key("sendMessage" as never), event as never, resolve);
  });
}

/** The message a send's receipt names, as a link to its document. */
function answeredMessage(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
): Cell<unknown> {
  expect(tx.status().status).not.toBe("error");
  expect(tx.handlingReceiptLink).toBeDefined();
  return runtime.getCellFromLink(tx.handlingReceiptLink!).key(
    "message" as never,
  ).resolveAsCell() as Cell<unknown>;
}

describe("fabrichat-send-requests", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let storageManager: EmulatedStorageManager;
  let runtime: Runtime;

  beforeEach(() => {
    server = newLoopbackServer();
    storageManager = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.idle();
    await storageManager?.synced();
    await runtime?.dispose();
    await storageManager?.close();
    await server?.close();
  });

  it("answers a repeated `requestId` with the first send's message, after other sends", async () => {
    const space = await runtime.createSpace({});
    const tx = runtime.edit();
    const profile = runtime.getCell<{ name: string }>(home, "viewer profile", {
      type: "object",
      properties: { name: { type: "string" } },
      ifc: { addIntegrity: ["fabrichat-test-profile"] },
    }, tx);
    profile.set({ name: "Viewer" });
    const catalog = runtime.getCell(
      home,
      "catalog",
      {
        type: "object",
        properties: { entries: { type: "object" }, offers: { type: "object" } },
      } as const satisfies JSONSchema,
      tx,
    );
    catalog.set({ entries: {}, offers: {} });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();

    const roomTx = runtime.edit();
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      { main: ROOM_PATH, root: PATTERNS },
    );
    const pattern = await runtime.patternManager.compilePattern(program, {
      space,
      tx: roomTx,
    });
    const room = runtime.run(
      roomTx,
      pattern,
      { profile, catalog },
      runtime.getCell(space, "room", undefined, roomTx),
    ) as Cell<unknown>;
    runtime.prepareTxForCommit(roomTx);
    expect((await roomTx.commit().settled).error).toBeUndefined();
    await runtime.idle();

    const first = answeredMessage(
      runtime,
      await sendTo(room, "yes!", "press-1"),
    );
    const second = answeredMessage(
      runtime,
      await sendTo(room, "yes!", "press-2"),
    );
    answeredMessage(runtime, await sendTo(room, "Something else", "press-3"));
    const repeat = answeredMessage(
      runtime,
      await sendTo(room, "yes!", "press-1"),
    );
    await runtime.idle();

    // Each answer names a message of its own, and the repeat names the first.
    expect(await first.key("body" as never).pull()).toBe("yes!");
    expect(second.equalLinks(first)).toBe(false);
    expect(repeat.equalLinks(first)).toBe(true);
    expect(await room.key("messages" as never).key("count" as never).pull())
      .toBe(3);
  });
});
