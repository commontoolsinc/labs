/**
 * One-off converter: integration/traverse_timing_test_data.json (a captured
 * server query dataset, see integration/traverse_timing.test.ts) → the
 * traverse-replay fixture format.
 *
 * Run from packages/runner:
 *   deno run --allow-read --allow-write \
 *     test/traverse-replay/convert-legacy-timing-data.ts
 */
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import {
  fixtureDocKey,
  type TraverseFixture,
} from "../../src/traverse-recorder.ts";

// The space the dataset was captured from: links inside the docs carry this
// space explicitly, so the corpus must be keyed by it (the original timing
// test used a space-agnostic store keyed by id only).
const SPACE = "did:key:z6MkkGMscCkDFETV5efoTSEybcVfo8muPQUp7qMa3mUGC4mF";
const ROOT_ID = "of:baedreibl64qzbhgkvpuxbfc657ugjeyidc62hixjybt5dpci2ddkkhs26m";

// The selector the original capture was queried with. The dataset predates
// the charm→piece rename, so the property names keep the old "charm" form
// (the in-repo timing test was mechanically renamed to "selectedPiece" and
// no longer matches its own data, which short-circuits its traversal).
const SELECTOR = {
  path: ["value"],
  schema: {
    type: "object",
    properties: {
      selectedCharm: {
        type: "object",
        properties: { charm: true },
        required: ["charm"],
        default: {},
      },
      charmsList: true,
    },
    required: ["selectedCharm"],
  },
} as const;

const sourcePath = new URL(
  "../../integration/traverse_timing_test_data.json",
  import.meta.url,
);
const outPath = new URL("./fixtures/piece-query-legacy.json", import.meta.url);

const data = JSON.parse(Deno.readTextFileSync(sourcePath)) as Record<
  string,
  Record<string, Record<string, { is: FabricValue }>>
>;

const docs: Record<string, FabricValue> = {};
for (const [uri, attrs] of Object.entries(data)) {
  const [[type, caused]] = Object.entries(attrs);
  const [[_cause, revision]] = Object.entries(caused);
  docs[fixtureDocKey({ space: SPACE, id: uri, type })] = revision.is;
}

const fixture: TraverseFixture = {
  version: 1,
  meta: {
    name: "piece-query-legacy",
    source: "integration/traverse_timing_test_data.json (captured server " +
      "query response; converted by convert-legacy-timing-data.ts)",
    description: "Server-shaped piece query over 36 real docs with links, " +
      "aliases and vnode trees. Single traversal, includeMeta=true.",
  },
  selectors: [structuredClone(SELECTOR) as TraverseFixture["selectors"][0]],
  links: [],
  docs: Object.fromEntries(
    Object.entries(docs).sort(([a], [b]) => a < b ? -1 : 1),
  ),
  invocations: [
    {
      address: {
        space: SPACE,
        id: ROOT_ID,
        type: "application/json",
        path: ["value"],
      },
      selector: 0,
      includeMeta: true,
      context: 0,
    },
  ],
};

Deno.mkdirSync(new URL("./fixtures/", import.meta.url), { recursive: true });
Deno.writeTextFileSync(outPath, JSON.stringify(fixture));
console.log(
  `wrote ${outPath.pathname}: ${Object.keys(docs).length} docs, ` +
    `${fixture.invocations.length} invocations`,
);
