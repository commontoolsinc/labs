import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";
import { LINK_V1_TAG, type SigilLink } from "../src/sigil-types.ts";
import { isStream } from "../src/cell.ts";

const signer = await Identity.fromPassphrase("parse-link stream base regression");
const space = signer.did();

describe("parseLink stream base", () => {
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
    await runtime?.storageManager.synced();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should safely resolve links when a Stream is provided as the base", async () => {
    const tx = runtime.edit();
    const backingCell = runtime.getCell(
      space,
      "regression-parseLink-stream-base",
      undefined,
      tx,
    );
    backingCell.set({
      events: { $stream: true },
    });
    await tx.commit();

    const schema = {
      type: "object",
      properties: {
        events: {
          type: "object",
          asStream: true,
        },
      },
      required: ["events"],
    } as const;

    const typedCell = backingCell.asSchema(schema);
    const eventsStream = typedCell.key("events");
    expect(isStream(eventsStream)).toBe(true);

    const sigil: SigilLink = {
      "/": {
        [LINK_V1_TAG]: {
          path: ["payload"],
        },
      },
    };

    const call = () => parseLink(sigil, eventsStream);

    expect(call).not.toThrow();
  });
});
