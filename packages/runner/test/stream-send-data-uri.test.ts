import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { hasDataUriScheme } from "@commonfabric/data-model/codec-data-uri";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { handler } from "../src/builder/module.ts";
import { pattern } from "../src/builder/pattern.ts";
import { type Cell, sendEvent } from "../src/cell.ts";
import { isCellLink, parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("stream send data uri");
const space = signer.did();

/** The ids of the links anywhere inside `value`. */
const linkIdsIn = (value: unknown): string[] => {
  const ids: string[] = [];
  const visit = (node: unknown): void => {
    if (isCellLink(node)) {
      ids.push(String(parseLink(node)!.id));
    } else if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (typeof node === "object" && node !== null) {
      Object.values(node).forEach(visit);
    }
  };
  visit(value);
  return ids;
};

describe("stream-send-data-uri", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let stream: Cell<unknown>;
  let queued: unknown[];

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    // Explicit schemas: a unit test compiles without the CTS transforms.
    const record = handler(
      true as const,
      { type: "object", properties: {} } as const,
      (_event, _ctx) => {},
    );
    const recorder = pattern<{ value: number }>(({ value }) => ({
      value,
      record: record({}),
    }));
    const tx = runtime.edit();
    const result = runtime.getCell<{ value: number; record: unknown }>(
      space,
      "stream-send-data-uri-result",
      undefined,
      tx,
    );
    runtime.run(tx, recorder, { value: 0 }, result);
    await tx.commit().settled;
    await runtime.idle();
    stream = result.key("record");

    // What a send hands the scheduler is what every arm of the send carries.
    queued = [];
    const queueEvent = runtime.scheduler.queueEvent.bind(runtime.scheduler);
    runtime.scheduler.queueEvent = (link, event, ...rest) => {
      queued.push(event);
      return queueEvent(link, event, ...rest);
    };
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** Sends `event` to the stream and resolves once its handling commits. */
  const send = (event: unknown) =>
    new Promise<void>((resolve) => {
      sendEvent(stream, event, () => resolve());
    });

  /** A cell over the first element of a stored array of inline objects. */
  const inlineElement = async (tx: IExtendedStorageTransaction) => {
    const target = runtime.getCell(space, "send-target", undefined, tx);
    target.set({ name: "x" });
    const holder = runtime.getCell(space, "send-holder", undefined, tx);
    holder.setRaw({
      items: [{ label: "one", ref: target.getAsLink() }],
    });
    await tx.commit().settled;
    return {
      element: holder.key("items").key(0).resolveAsCell(),
      targetId: String(target.getAsNormalizedFullLink().id),
    };
  };

  it("carries an inline array element as its value", async () => {
    const { element, targetId } = await inlineElement(runtime.edit());
    expect(hasDataUriScheme(element.getAsNormalizedFullLink().id)).toBe(true);

    await send({ item: element });

    expect(queued).toHaveLength(1);
    const event = queued[0] as { item: { label: string; ref: unknown } };
    expect(isCellLink(event.item)).toBe(false);
    expect(event.item.label).toBe("one");
    expect(linkIdsIn(event)).toEqual([targetId]);
  });

  it("carries an immutable cell as its value", async () => {
    const immutable = runtime.getImmutableCell(space, { count: 3 });
    expect(hasDataUriScheme(immutable.getAsNormalizedFullLink().id)).toBe(
      true,
    );

    await send({ boxed: immutable });

    expect(queued).toEqual([{ boxed: { count: 3 } }]);
  });

  it("carries a cell stored in a space as a link to it", async () => {
    const tx = runtime.edit();
    const stored = runtime.getCell(space, "send-stored", undefined, tx);
    stored.set({ name: "y" });
    await tx.commit().settled;

    await send({ item: stored });

    expect(linkIdsIn(queued[0])).toEqual([
      String(stored.getAsNormalizedFullLink().id),
    ]);
  });
});
