import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { HarnessFetch } from "../src/contracts/http-fetch.ts";
import { PatternIndexClient } from "../src/pattern-index/client.ts";
import type { PatternIndexPublishRequest } from "../src/pattern-index/client.ts";
import {
  createPatternIndexPublicationLedger,
  patternCapabilityKey,
} from "../src/pattern-index/publish-ledger.ts";

const signer = await Identity.fromPassphrase("cf-harness publish ledger");

interface RecordedCall {
  fn: string;
  body: Record<string, unknown>;
}

/**
 * A stub index whose `settled` resolves when a function has ANSWERED, not
 * when a wall-clock delay has passed. The ledger deliberately does not await
 * its own publications, so the call answering is the only event a test can
 * hang on for one — and it is a real event, which is what
 * `docs/development/waiting-in-tests.md` asks for in place of a sleep.
 */
const stubClient = (options: { fail?: boolean; created?: boolean } = {}) => {
  const calls: RecordedCall[] = [];
  const waiters: { fn: string; count: number; resolve: () => void }[] = [];
  const answered: Record<string, number> = {};
  const announce = (fn: string) => {
    answered[fn] = (answered[fn] ?? 0) + 1;
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter.fn === fn && answered[fn] >= waiter.count) {
        waiters.splice(index, 1);
        waiter.resolve();
      }
    }
  };
  const fetchFn: HarnessFetch = (input, init) => {
    const fn = String(input).split("/").pop() ?? "";
    const body = JSON.parse(
      typeof init?.body === "string" ? init.body : "{}",
    ) as Record<string, unknown>;
    calls.push({ fn, body });
    const answer = (response: Response): Promise<Response> => {
      announce(fn);
      return Promise.resolve(response);
    };
    if (fn === "publishPattern" && options.fail === true) {
      return answer(
        new Response(JSON.stringify({ error: "index is down" }), {
          status: 500,
        }),
      );
    }
    return answer(
      new Response(
        JSON.stringify(
          fn === "publishPattern"
            ? { patternId: body.patternId, created: options.created ?? true }
            : { ok: true },
        ),
        { status: 200 },
      ),
    );
  };
  const client = new PatternIndexClient({
    baseUrl: "https://index.test",
    fetchFn,
    signer,
  });
  return {
    calls,
    getClient: () => Promise.resolve(client),
    settled(fn: string, count: number): Promise<void> {
      if ((answered[fn] ?? 0) >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push({ fn, count, resolve });
      });
    },
  };
};

const request = (
  patternId: string,
  overrides: Partial<PatternIndexPublishRequest> = {},
): PatternIndexPublishRequest => ({
  patternId,
  description: "Sortable table",
  hashtags: ["table"],
  directQuery: "build me a sortable table",
  program: {
    main: "/main.tsx",
    files: [{ name: "/main.tsx", contents: `// ${patternId}` }],
  },
  ...overrides,
});

const publishes = (calls: RecordedCall[]) =>
  calls.filter((call) => call.fn === "publishPattern");

describe("pattern index publication ledger", () => {
  describe("patternCapabilityKey()", () => {
    it("reads two spellings of one description as one capability", () => {
      expect(patternCapabilityKey(request("a"))).toBe(
        patternCapabilityKey(
          request("b", { description: "  Sortable   TABLE " }),
        ),
      );
    });

    it("does not care what order the hashtags arrived in", () => {
      expect(
        patternCapabilityKey(request("a", { hashtags: ["table", "sort"] })),
      ).toBe(
        patternCapabilityKey(request("b", { hashtags: ["Sort", "Table"] })),
      );
    });

    it("separates two capabilities described differently", () => {
      expect(patternCapabilityKey(request("a"))).not.toBe(
        patternCapabilityKey(request("b", { description: "Doubles a number" })),
      );
    });
  });

  describe("stage() and flush()", () => {
    it("publishes nothing until the session ends", async () => {
      const { calls, getClient } = stubClient();
      const ledger = createPatternIndexPublicationLedger(getClient);
      ledger.stage(request("one"));
      expect(publishes(calls)).toEqual([]);
      await ledger.flush();
      expect(publishes(calls)).toHaveLength(1);
    });

    it("offers search the last of a capability's iterations and records the rest", async () => {
      const { calls, getClient } = stubClient();
      const ledger = createPatternIndexPublicationLedger(getClient);
      ledger.stage(request("first"));
      ledger.stage(request("second"));
      ledger.stage(request("third"));
      await ledger.flush();

      const sent = publishes(calls);
      expect(sent.map((call) => call.body.patternId)).toEqual([
        "first",
        "second",
        "third",
      ]);
      // Every iteration is recorded; one of them is discoverable.
      expect(sent.map((call) => call.body.discoverable)).toEqual([
        false,
        false,
        undefined,
      ]);
      expect(sent[0].body.discoverabilityReason).toContain("superseded");
    });

    it("publishes a displaced iteration as soon as it is displaced", async () => {
      // Only the latest of each capability is at risk if the session dies, so
      // the displaced one has to be gone BEFORE the flush — measured before
      // it, since after it the two sends are indistinguishable.
      const { calls, getClient, settled } = stubClient();
      const ledger = createPatternIndexPublicationLedger(getClient);
      ledger.stage(request("first"));
      ledger.stage(request("second"));
      // `stage` does not await, so the displaced send rides the ledger's own
      // chain. Waiting on that call ANSWERING is the event; a wall-clock
      // delay would be guessing at how long the chain takes, which is how
      // this test first failed in CI and passed here.
      await settled("publishPattern", 1);
      expect(publishes(calls).map((call) => call.body.patternId)).toEqual([
        "first",
      ]);
      await ledger.flush();
      expect(publishes(calls).map((call) => call.body.patternId)).toEqual([
        "first",
        "second",
      ]);
    });

    it("offers search each of a session's distinct capabilities", async () => {
      const { calls, getClient } = stubClient();
      const ledger = createPatternIndexPublicationLedger(getClient);
      ledger.stage(request("table"));
      ledger.stage(request("doubler", { description: "Doubles a number" }));
      await ledger.flush();

      expect(publishes(calls).map((call) => call.body.discoverable)).toEqual([
        undefined,
        undefined,
      ]);
    });

    it("keeps a render gate's own reason on an entry that is also superseded", async () => {
      // What a person reads later should say what was found. Being displaced
      // is the less informative of the two facts.
      const { calls, getClient } = stubClient();
      const ledger = createPatternIndexPublicationLedger(getClient);
      ledger.stage(
        request("first", {
          nonDiscoverable: { reason: "render gate: broken" },
        }),
      );
      ledger.stage(request("second"));
      await ledger.flush();

      expect(publishes(calls)[0].body.discoverabilityReason).toBe(
        "render gate: broken",
      );
    });

    it("publishes a held dependency before the entry that composes it", async () => {
      // The index refuses a publication naming a dependency it does not
      // hold, so a session composing an atom it authored earlier has to send
      // that atom first.
      const { calls, getClient } = stubClient();
      const ledger = createPatternIndexPublicationLedger(getClient);
      ledger.stage(request("doubler", { description: "Doubles a number" }));
      ledger.stage(
        request("quadrupler", {
          description: "Quadruples a number",
          dependencies: ["doubler"],
        }),
      );
      await ledger.flush();

      const sent = publishes(calls);
      expect(sent.map((call) => call.body.patternId)).toEqual([
        "doubler",
        "quadrupler",
      ]);
      // A dependency is not superseded — something composes it, so it is a
      // part of this session's output in its own right.
      expect(sent[0].body.discoverable).toBeUndefined();
    });

    it("names a dependency-published entry as the lineage of its next iteration", async () => {
      const { calls, getClient } = stubClient();
      const ledger = createPatternIndexPublicationLedger(getClient);
      ledger.stage(request("first"));
      ledger.stage(
        request("other", {
          description: "Something else",
          dependencies: ["first"],
        }),
      );
      ledger.stage(request("second"));
      await ledger.flush();

      const second = publishes(calls).find((call) =>
        call.body.patternId === "second"
      );
      expect(second?.body.priorPatternId).toBe("first");
    });

    it("reports a failed publication without throwing it at the session", async () => {
      const errors: string[] = [];
      const { getClient } = stubClient({ fail: true });
      const ledger = createPatternIndexPublicationLedger(getClient, {
        onError: (message) => errors.push(message),
      });
      ledger.stage(request("one"));
      await ledger.flush();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("could not publish");
    });

    it("records a created event for an entry the index did not hold", async () => {
      const { calls, getClient } = stubClient();
      const ledger = createPatternIndexPublicationLedger(getClient);
      ledger.stage(request("one"));
      await ledger.flush();
      expect(
        calls.filter((call) => call.fn === "recordEvent").map((call) =>
          call.body.eventType
        ),
      ).toEqual(["created"]);
    });

    it("records no created event for an entry the index already held", async () => {
      const { calls, getClient } = stubClient({ created: false });
      const ledger = createPatternIndexPublicationLedger(getClient);
      ledger.stage(request("one"));
      await ledger.flush();
      expect(calls.filter((call) => call.fn === "recordEvent")).toEqual([]);
    });

    it("publishes a dependency first even when it was staged second", async () => {
      const { calls, getClient } = stubClient();
      const ledger = createPatternIndexPublicationLedger(getClient);
      ledger.stage(
        request("composite", {
          description: "Composes the doubler",
          dependencies: ["doubler"],
        }),
      );
      ledger.stage(request("doubler", { description: "Doubles a number" }));
      await ledger.flush();

      expect(publishes(calls).map((call) => call.body.patternId)).toEqual([
        "doubler",
        "composite",
      ]);
    });
  });
});
