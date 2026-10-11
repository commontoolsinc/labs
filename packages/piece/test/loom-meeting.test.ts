/** Meeting binding preserves malformed storage and survives source updates. */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { createSession, Identity } from "@commonfabric/identity";
import {
  type Cell,
  getPatternIdentityRef,
  Runtime,
  type RuntimeProgram,
  sendEvent,
  type Stream,
} from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("loom meeting contract");

/** Sends an event and waits for its handler transaction. */
const sendAndSettle = (
  stream: Readonly<Stream<unknown>>,
  event: unknown,
  eventId: string,
): Promise<void> =>
  new Promise((resolve, reject) =>
    sendEvent(stream, event, (tx) => {
      const status = tx.status();
      if (status.status === "error") reject(status.error);
      else resolve();
    }, { eventId, session: signer.did() })
  );

describe("loom meeting", () => {
  let manager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;
  let root: Cell<unknown>;
  let program: RuntimeProgram;

  beforeEach(async () => {
    manager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager: manager,
    });
    pieces = new PiecesController(
      createSession({
        identity: signer,
        spaceDid: await runtime.createSpace(),
      }),
      runtime,
    );
    await pieces.ready;
    program = await resolveLocalProgram(
      runtime.harness.resolve.bind(runtime.harness),
      {
        root: fromFileUrl(new URL("../../patterns/", import.meta.url)),
        main: fromFileUrl(
          new URL("../../patterns/loom/main.tsx", import.meta.url),
        ),
        testPaths: [
          fromFileUrl(
            new URL("../../patterns/loom/meeting.test.tsx", import.meta.url),
          ),
        ],
      },
    );
    const compiled = await runtime.patternManager.compilePattern(program, {
      space: pieces.getSpace(),
    });
    root = await pieces.runPersistent(compiled, {}, "loom meeting");
  });

  afterEach(async () => {
    await runtime.dispose();
    await manager.close();
  });

  it("preserves meeting state through refusals and a source update", async () => {
    const key = "a".repeat(64);
    const meetingSchema = {
      type: "object",
      properties: {
        meeting: { type: "object", additionalProperties: true },
        bindMeeting: { asCell: ["stream"] },
      },
      required: ["meeting", "bindMeeting"],
    } as const;
    const output = root.asSchema(meetingSchema);
    const bind = await output.key("bindMeeting").pull();
    const meeting = pieces.getArgument(root).key("meeting").asSchema(undefined);
    const reply = runtime.getCell(pieces.getSpace(), "meeting reply");
    const malformed = [null, [], "unexpected", 12, { key: 12 }, {
      key: `${key}\n`,
    }, {
      future: true,
    }];
    for (const [index, value] of malformed.entries()) {
      const { error } = await runtime.editWithRetry((tx) => {
        meeting.withTx(tx).set(value);
      });
      expect(error).toBeUndefined();
      await sendAndSettle(bind, { key, reply }, `meeting-malformed-${index}`);
      expect(meeting.getRaw()).toEqual(value);
      expect(await reply.pull()).toEqual({ status: "invalid-state" });
    }
    const stored = { key, future: { preserved: true } };
    const { error } = await runtime.editWithRetry((tx) => {
      meeting.withTx(tx).set(stored);
    });
    expect(error).toBeUndefined();
    await sendAndSettle(bind, { key, reply }, "meeting-before-update");
    expect(await reply.pull()).toEqual({ status: "already-bound", key });

    const controller = await pieces.get(root.getAsNormalizedFullLink().id);
    const before = getPatternIdentityRef(root)?.identity;
    await controller.setPattern({
      ...program,
      files: program.files.map((file) =>
        file.name === program.main
          ? {
            ...file,
            contents: file.contents.replace(
              "<cf-screen>",
              '<cf-screen data-source-update="true">',
            ),
          }
          : file
      ),
    });
    await runtime.idle();
    expect(getPatternIdentityRef(root)?.identity).not.toBe(before);
    expect(output.key("meeting").getRaw({ lastNode: "value" })).toEqual(
      stored,
    );
    await sendAndSettle(
      await output.key("bindMeeting").pull(),
      { key: "b".repeat(64), reply },
      "meeting-after-update",
    );
    expect(await reply.pull()).toEqual({ status: "conflict", key });
    expect(output.key("meeting").getRaw({ lastNode: "value" })).toEqual(
      stored,
    );
  });
});
