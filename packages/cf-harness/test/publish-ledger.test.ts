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

const stubClient = (options: { fail?: boolean } = {}) => {
  const calls: RecordedCall[] = [];
  const fetchFn: HarnessFetch = (input, init) => {
    const fn = String(input).split("/").pop() ?? "";
    const body = JSON.parse(
      typeof init?.body === "string" ? init.body : "{}",
    ) as Record<string, unknown>;
    calls.push({ fn, body });
    if (fn === "publishPattern" && options.fail === true) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: "index is down" }), {
          status: 500,
        }),
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify(
          fn === "publishPattern"
            ? { patternId: body.patternId, created: true }
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
  return { calls, getClient: () => Promise.resolve(client) };
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
      // Only the latest of each capability is at risk if the session dies.
      const { calls, getClient } = stubClient();
      const ledger = createPatternIndexPublicationLedger(getClient);
      ledger.stage(request("first"));
      ledger.stage(request("second"));
      await ledger.flush();
      expect(publishes(calls)[0].body.patternId).toBe("first");
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

    it("records a created event only for an entry the index did not hold", async () => {
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
  });
});
