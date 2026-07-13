import { assertEquals } from "@std/assert";
import { normalizeEntityId } from "../src/lib/debug-utils.ts";

// The debug command surface and the scheduler graph both bridge between
// human/bare ids and the full schemed URIs that programmatic surfaces
// (diagnostics pieceId, error strings) emit. Full schemed ids pass through
// untouched — the scheme is part of the identity — while adding `of:` to a
// bare id is a human-input convenience only.

Deno.test("normalizeEntityId prefixes bare ids and passes schemed ids through", () => {
  // Bare id (typed or copied from a URL path): of: is the convenience.
  assertEquals(normalizeEntityId({ id: "fid1:abc" }), "of:fid1:abc");
  // Full schemed ids are canonical either way.
  assertEquals(normalizeEntityId({ id: "of:fid1:abc" }), "of:fid1:abc");
  assertEquals(
    normalizeEntityId({ id: "computed:fid1:abc" }),
    "computed:fid1:abc",
  );
  // The did fallback follows the same rule.
  assertEquals(normalizeEntityId({ did: "fid1:def" }), "of:fid1:def");
  assertEquals(
    normalizeEntityId({ did: "computed:fid1:def" }),
    "computed:fid1:def",
  );
});

Deno.test("SchedulerGraphView strips entity URI schemes when parsing action ids", async () => {
  const { XSchedulerGraph } = await import(
    "../src/views/SchedulerGraphView.ts"
  );
  const proto = XSchedulerGraph.prototype as unknown as {
    extractEntityId(actionId: string): string | undefined;
    truncateLabel(label: string, maxLen?: number): string;
  };

  // extractEntityId: the scheme precedes the entity id; both schemes strip.
  assertEquals(
    proto.extractEntityId.call(proto, "sink:did:key:z6Mkabc/of:fid1:AAA/path"),
    "fid1:AAA",
  );
  assertEquals(
    proto.extractEntityId.call(
      proto,
      "action:pattern:did:key:z6Mkabc/computed:fid1:BBB/value",
    ),
    "fid1:BBB",
  );

  // truncateLabel: schemed segments are recognized so the label keeps the
  // entity tail and path instead of blind truncation.
  const ofLabel = proto.truncateLabel.call(
    proto,
    "sink:did:key:z6MkabcdefghijkLMNOP/of:fid1:AAAABBBBCCCCDDDD/value",
  );
  assertEquals(ofLabel.includes("DDDD"), true);
  assertEquals(ofLabel.includes("value"), true);
  const computedLabel = proto.truncateLabel.call(
    proto,
    "sink:did:key:z6MkabcdefghijkLMNOP/computed:fid1:EEEEFFFFGGGGHHHH/count",
  );
  assertEquals(computedLabel.includes("HHHH"), true);
  assertEquals(computedLabel.includes("count"), true);
});
