import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "@commonfabric/runner";
import { WorkerReconciler } from "../src/worker/reconciler.ts";
import type { VDomOp } from "../src/vdom-ops.ts";

/**
 * What the reconciler declares to a verb about the event it delivers.
 *
 * A DOM event is the renderer's construction: the pattern wires a stream to
 * `onClick` and the serializer decides what a click looks like. The send says
 * so, through the mint-gated `runtimeInjectedEventKeys` option, and the
 * closed-world gate leaves exactly those keys unjudged. The rule the gate
 * exists to enforce survives only if that declaration stays bounded — hence
 * the second case, which is the one that would rot first.
 */

const signer = await Identity.fromPassphrase("test reconciler event injection");

type SendCall = {
  event: unknown;
  options?: { runtimeInjectedEventKeys?: readonly string[] };
};

const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  storageManager,
  apiUrl: new URL("http://localhost"),
});
const dummyTx = runtime.edit();
const CellImplConstructor = runtime
  .getCell(signer.did(), "dummy", undefined, dummyTx)
  .constructor;

class MockCell extends (CellImplConstructor as any) {
  constructor(public value: unknown) {
    super(runtime, undefined, undefined, false, undefined, "cell");
    this.value = value;
  }

  sink(callback: (value: unknown) => void) {
    callback(this.value);
    return () => {};
  }

  isStream() {
    return false;
  }
}

/** Records what the reconciler hands `send`, options included. */
class MockStream extends MockCell {
  static nextId = 0;
  public calls: SendCall[] = [];
  private readonly linkId = `event-injection-stream-${++MockStream.nextId}`;

  constructor() {
    super(undefined);
  }

  override isStream() {
    return true;
  }

  withTx(_tx?: unknown) {
    return this;
  }

  send(event: unknown, _onCommit?: unknown, options?: SendCall["options"]) {
    this.calls.push({ event, options });
  }

  getAsNormalizedFullLink() {
    return { space: "test-space", id: this.linkId, path: [] };
  }
}

/**
 * Mount a button whose `onclick` is `stream`, then deliver `event` to the
 * handler the reconciler registered for it.
 */
const deliver = (event: unknown): SendCall => {
  const ops: VDomOp[] = [];
  const stream = new MockStream();
  const reconciler = new WorkerReconciler({
    onOps: (batch: VDomOp[]) => {
      ops.push(...batch);
      return 0;
    },
  });
  const root = new MockCell({
    type: "vnode",
    name: "button",
    props: { onclick: stream },
    children: ["Click"],
  });
  const cancel = reconciler.mount(root as never);
  try {
    reconciler.flush();
    const setEvent = ops.find((op) => op.op === "set-event") as Extract<
      VDomOp,
      { op: "set-event" }
    >;
    expect(reconciler.dispatchEvent(setEvent.handlerId, event)).toBe(true);
    expect(stream.calls.length).toBe(1);
    return stream.calls[0];
  } finally {
    cancel();
  }
};

describe("worker-reconciler-event-injection", () => {
  it("declares the envelope keys the delivered event carries", () => {
    const { options } = deliver({
      type: "click",
      provenance: { origin: "dom", trusted: true },
      altKey: false,
      button: 0,
      target: { value: "typed text" },
      detail: 1,
    });

    expect(options?.runtimeInjectedEventKeys).toEqual([
      "type",
      "altKey",
      "button",
      "provenance",
      "target",
      "detail",
    ]);
  });

  it("declares only keys the serializer can produce", () => {
    // The bound is the envelope, not the event value's own keys. A field no
    // serializer writes stays the caller's, so a verb whose closed event
    // schema does not declare it still rejects the send — the rule the
    // closed-world gate exists to enforce.
    const { options } = deliver({ type: "click", title: "smuggled" });

    expect(options?.runtimeInjectedEventKeys).toEqual(["type"]);
  });

  it("mints the declaration, so the send path honors it", () => {
    // `Cell.set`'s stream branch forwards the option only for an array minted
    // by `markRuntimeInjectedEventKeys`, which freezes what it mints.
    const { options } = deliver({ type: "click" });

    expect(Object.isFrozen(options?.runtimeInjectedEventKeys)).toBe(true);
  });

  it("declares nothing for an event that is not a record", () => {
    const { options } = deliver(undefined);

    expect(options?.runtimeInjectedEventKeys).toBeUndefined();
  });
});
