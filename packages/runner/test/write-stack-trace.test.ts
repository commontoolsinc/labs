import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import {
  getWriteStackTrace,
  setWriteStackTraceMatchers,
} from "../src/storage/write-stack-trace.ts";

const signer = await Identity.fromPassphrase("write stack trace test operator");
const space = signer.did();

describe("write stack trace", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    setWriteStackTraceMatchers([]);
  });

  afterEach(async () => {
    setWriteStackTraceMatchers([]);
    await runtime.dispose();
    await storageManager.close();
  });

  it("captures stacks for matched logical write paths", () => {
    setWriteStackTraceMatchers([{
      space,
      entityId: "doc:root",
      path: [],
      match: "exact",
      label: "root doc write",
    }]);

    function performMatchedWrite() {
      const tx = runtime.edit();
      try {
        tx.writeValueOrThrow(
          {
            space,
            id: "doc:root",
            type: "application/json",
            path: [],
          },
          { title: "Hello" },
        );
      } finally {
        tx.abort();
      }
    }

    performMatchedWrite();

    expect(getWriteStackTrace()).toEqual([{
      recordedAt: expect.any(Number),
      space,
      entityId: "doc:root",
      path: [],
      match: "exact",
      label: "root doc write",
      result: "ok",
      valueKind: "object",
      stack: expect.stringContaining("performMatchedWrite"),
    }]);
  });

  it("propagates write debug context across async runtime edits", async () => {
    setWriteStackTraceMatchers([{
      space,
      entityId: "doc:async",
      path: [],
      match: "exact",
      label: "async root doc write",
    }]);

    await runtime.withWriteDebugContext("raw:navigateTo", async () => {
      await Promise.resolve();
      const tx = runtime.edit();
      try {
        tx.writeValueOrThrow(
          {
            space,
            id: "doc:async",
            type: "application/json",
            path: [],
          },
          { title: "Later" },
        );
      } finally {
        tx.abort();
      }
    });

    expect(getWriteStackTrace()).toEqual([{
      recordedAt: expect.any(Number),
      space,
      entityId: "doc:async",
      path: [],
      writerActionId: "raw:navigateTo",
      match: "exact",
      label: "async root doc write",
      result: "ok",
      valueKind: "object",
      stack: expect.stringContaining("writeValueOrThrow"),
    }]);
  });
});
