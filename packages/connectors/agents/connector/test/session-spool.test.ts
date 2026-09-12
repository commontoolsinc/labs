import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";

import { SessionSpool } from "../src/session-spool.ts";
import type { NativeSessionSnapshot } from "../src/types.ts";

describe("SessionSpool", () => {
  const snapshot = (id: string): NativeSessionSnapshot => ({
    summary: {
      nativeSessionId: id,
      title: id,
      cwd: null,
      createdAt: null,
      updatedAt: null,
      archived: false,
      active: false,
      raw: { id },
    },
    events: [],
    normalizedMessages: [],
    complete: true,
  });

  describe("instance members", () => {
    describe("append()", () => {
      it("captures native values and sparse arrays before the caller mutates them", async () => {
        await using spool = await SessionSpool.create();
        const bytes = new Uint8Array([1, 2, 3]);
        const events = [bytes, , undefined, -0];
        const first = { ...snapshot("one"), events };
        await spool.append(first);
        bytes[0] = 9;
        first.summary.title = "changed";
        events[1] = 5;
        await spool.append(snapshot("two"));

        expect(spool.length).toBe(2);
        const values = await Array.fromAsync(spool);
        expect(values.map((value) => value.summary.title)).toEqual([
          "one",
          "two",
        ]);
        expect((values[0].events[0] as FabricBytes).slice()).toEqual(
          new Uint8Array([1, 2, 3]),
        );
        expect(1 in values[0].events).toBe(false);
        expect(2 in values[0].events).toBe(true);
        expect(values[0].events[2]).toBeUndefined();
        expect(values[0].events[3]).toBe(-0);
        expect(await Array.fromAsync(spool)).toEqual(values);
      });
    });

    describe("[Symbol.asyncDispose]()", () => {
      it("removes persisted snapshots when iteration ends early", async () => {
        const spool = await SessionSpool.create();
        await spool.append(snapshot("one"));
        await spool.append(snapshot("two"));
        for await (const value of spool) {
          expect(value.summary.title).toBe("one");
          break;
        }
        await spool[Symbol.asyncDispose]();
        await expect(Array.fromAsync(spool)).rejects.toThrow(
          Deno.errors.NotFound,
        );
      });
    });
  });
});
