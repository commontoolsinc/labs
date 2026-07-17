import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { sandboxDateNow, sandboxRandom } from "../src/builder/safe-builtins.ts";
import { Runtime } from "../src/runtime.ts";
import { type JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

const STREAM_SCHEMA = {
  type: "object",
  properties: { events: { type: "object", asCell: ["stream"] } },
} as const satisfies JSONSchema;

// Gate behavior for the gated ambient clock/entropy intrinsics sandboxDateNow()/
// sandboxRandom() (W1 keystone). They read the lift-vs-handler context from the
// active frame — coarse inside a handler, throwing everywhere else — so we
// exercise them by pushing a frame with or without `inHandler` rather than
// spinning up a full pattern.

function fakeRuntime(): Runtime {
  return { experimental: {} } as unknown as Runtime;
}

function inFrame<T>(
  props: { inHandler?: boolean },
  fn: () => T,
): T {
  const frame = pushFrame({
    runtime: fakeRuntime(),
    ...(props.inHandler ? { inHandler: true } : {}),
  });
  try {
    return fn();
  } finally {
    popFrame(frame);
  }
}

describe("time/entropy capability gate", () => {
  it("lift/pattern-body context: both throw", () => {
    inFrame({}, () => {
      expect(() => sandboxDateNow()).toThrow("not available in this context");
      expect(() => sandboxRandom()).toThrow("not available in this context");
    });
  });

  it("handler context: clock is coarsened to 1s, entropy passes", () => {
    inFrame({ inHandler: true }, () => {
      const t = sandboxDateNow();
      expect(typeof t).toBe("number");
      expect(t % 1000).toBe(0);
      expect(typeof sandboxRandom()).toBe("number");
    });
  });

  it("no frame at all: both throw (ambient time/entropy is never exposed)", () => {
    expect(() => sandboxDateNow()).toThrow();
    expect(() => sandboxRandom()).toThrow();
  });
});

describe("lift event-emit gate", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  function makeStream(
    rt: Runtime,
    t: IExtendedStorageTransaction,
    cause: string,
  ) {
    const c = rt.getCell(space, cause, undefined, t);
    c.set({ events: { $stream: true } });
    return c.asSchema(STREAM_SCHEMA).key("events");
  }

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("lift frame: emitting to a stream throws", () => {
    const stream = makeStream(runtime, tx, "emit-gate/lift");
    const frame = pushFrame({ frameKind: "lift" });
    try {
      expect(() => stream.send({ n: 1 })).toThrow("must be pure");
    } finally {
      popFrame(frame);
    }
  });

  it("handler frame: emitting to a stream is allowed", () => {
    const stream = makeStream(runtime, tx, "emit-gate/handler");
    const frame = pushFrame({ frameKind: "handler" });
    try {
      expect(() => stream.send({ n: 1 })).not.toThrow();
    } finally {
      popFrame(frame);
    }
  });

  it("no pattern frame (internal/renderer send): allowed", () => {
    const stream = makeStream(runtime, tx, "emit-gate/internal");
    expect(() => stream.send({ n: 1 })).not.toThrow();
  });
});
