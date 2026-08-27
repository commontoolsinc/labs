/**
 * What the worker's outbound side does with a message the encoding refuses.
 *
 * `postToClient()` is the whole of that side, so it is also the only place a
 * failure to encode can be answered. What it answers with differs by whether
 * anyone is awaiting a reply, and it must not throw either way.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { fabricFromRealmValue } from "@commonfabric/data-model/codecs";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";

import { postToClient } from "@/backends/post-to-client.ts";
import { NotificationType } from "@/protocol/mod.ts";

/**
 * A value that passes every `FabricValue` check and has no encoding: an object
 * forged onto a `FabricPrimitive`'s prototype. Building one takes deliberate
 * effort, which is why nothing probes for it -- and why what happens when one
 * arrives is worth pinning.
 */
function forged(): unknown {
  return Object.create(FabricBytes.prototype);
}

/** Captures what the worker posts, decoding it as the client's transport does. */
function capturing(): {
  posted: Record<string, unknown>[];
  restore: () => void;
} {
  const posted: Record<string, unknown>[] = [];
  const original = (globalThis as { postMessage?: unknown }).postMessage;
  (globalThis as { postMessage: (m: unknown) => void }).postMessage = (m) => {
    posted.push(
      fabricFromRealmValue(m as never) as Record<string, unknown>,
    );
  };
  return {
    posted,
    restore: () => {
      (globalThis as { postMessage?: unknown }).postMessage = original;
    },
  };
}

describe("post-to-client", () => {
  describe("a message the encoding refuses", () => {
    it("answers a reply as a failure, so the request settles", () => {
      // The client is awaiting this `msgId`. Dropping the message would leave
      // that request hanging until it times out, so it is answered rather
      // than reported.
      const { posted, restore } = capturing();

      try {
        postToClient(
          { msgId: 7, data: { value: forged() } } as never,
        );

        expect(posted).toHaveLength(1);
        expect(posted[0].msgId).toBe(7);
        expect(posted[0].error).toContain("Undeliverable message");
      } finally {
        restore();
      }
    });

    it("reports a notification, carrying a rendering of what was lost", () => {
      // Nobody is awaiting a notification, so there is no reply to make -- but
      // dropping it silently is the outcome worth avoiding, most of all for
      // the console.
      const { posted, restore } = capturing();

      try {
        postToClient(
          {
            type: NotificationType.ConsoleMessage,
            method: "log",
            args: [forged()],
          } as never,
        );

        expect(posted).toHaveLength(1);
        expect(posted[0].type).toBe(NotificationType.ErrorReport);
        expect(posted[0].message).toContain("Undeliverable message");
        // The rendering names the message, so a reader can tell which one went.
        expect(posted[0].message).toContain("console");
      } finally {
        restore();
      }
    });

    it("does not throw, which is the whole point", () => {
      // On the console path this runs inside a synchronous `EventTarget`
      // listener, where a throw is an uncaught error rather than something a
      // caller can catch -- fatal under Deno.
      const { restore } = capturing();

      try {
        expect(() => postToClient({ type: "x", args: [forged()] } as never))
          .not.toThrow();
      } finally {
        restore();
      }
    });
  });
});
