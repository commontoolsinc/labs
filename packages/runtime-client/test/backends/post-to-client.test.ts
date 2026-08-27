import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { postToClient } from "@/backends/post-to-client.ts";
import { NotificationType } from "@/protocol/mod.ts";

/**
 * Captures what the worker posts, standing in for the real `self.postMessage`
 * — which is read off `self` at call time so that this substitution works.
 */
function capturing(): {
  posted: Record<string, unknown>[];
  restore: () => void;
} {
  const posted: Record<string, unknown>[] = [];
  const original = (globalThis as { postMessage?: unknown }).postMessage;
  (globalThis as { postMessage: (m: unknown) => void }).postMessage = (m) => {
    // Refuse exactly what a real `postMessage` refuses, by asking the same
    // algorithm rather than by guessing which values those are.
    structuredClone(m);
    posted.push(m as Record<string, unknown>);
  };
  return {
    posted,
    restore: () => {
      (globalThis as { postMessage?: unknown }).postMessage = original;
    },
  };
}

describe("post-to-client", () => {
  describe("a message `postMessage` refuses", () => {
    // An interned `symbol` is a `FabricValue`, so the protocol types admit one
    // and structured cloning throws on it, nested or not. That is the whole
    // gap: this is the worker's only outbound call, and the notification paths
    // reach it from a microtask where a throw is uncaught.

    it("answers a reply as a failure, so the request settles", () => {
      const { posted, restore } = capturing();

      try {
        // The return is the contract: `web-worker/index.ts` counts a reply
        // as `responded` or `responded-error` by it, so an implementation that
        // substituted while still answering `true` would misreport every
        // refused reply and pass on the posted message alone.
        expect(
          postToClient(
            {
              msgId: 7,
              data: { value: Symbol.for("cf.test.unpostable") },
            } as never,
          ),
        ).toBe(false);

        expect(posted).toHaveLength(1);
        expect(posted[0].msgId).toBe(7);
        expect(posted[0].error).toContain("Undeliverable message");
      } finally {
        restore();
      }
    });

    it("reports a notification, carrying a rendering of what was lost", () => {
      const { posted, restore } = capturing();

      try {
        expect(
          postToClient(
            {
              type: NotificationType.CellUpdate,
              cell: {
                id: "of:x",
                space: "did:key:t",
                scope: "space",
                path: [],
              },
              value: Symbol.for("cf.test.unpostable"),
            } as never,
          ),
        ).toBe(false);

        expect(posted).toHaveLength(1);
        expect(posted[0].type).toBe(NotificationType.ErrorReport);
        expect(posted[0].message).toContain("Undeliverable message");
        // The rendering names the message, so a reader can tell which one went.
        expect(posted[0].message).toContain("cell:update");
      } finally {
        restore();
      }
    });

    it("does not throw, which is the whole point", () => {
      // The notification paths post from a `queueMicrotask` callback, where a
      // throw is an uncaught error rather than something a caller catches.
      const { restore } = capturing();

      try {
        let delivered: boolean | undefined;
        expect(() => {
          delivered = postToClient(
            {
              type: NotificationType.ErrorReport,
              message: Symbol.for("x"),
            } as never,
          );
        }).not.toThrow();
        expect(delivered).toBe(false);
      } finally {
        restore();
      }
    });

    it("posts an ordinary message unchanged", () => {
      // Without this the three above pass for an implementation that
      // substitutes unconditionally.
      const { posted, restore } = capturing();

      try {
        expect(postToClient({ msgId: 8, data: { value: 1 } } as never))
          .toBe(true);

        expect(posted).toEqual([{ msgId: 8, data: { value: 1 } }]);
      } finally {
        restore();
      }
    });
  });
});
