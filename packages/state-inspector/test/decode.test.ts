// Decode safety: modern `FabricLink` instances are recognized as links (not
// dropped as opaque objects), and non-JSON-safe Fabric leaves (BigInt, Fabric
// instances) survive `annotate` → `JSON.stringify` without throwing or becoming
// `{}`. Both are the at-rest shapes a real `fvj1` DB can produce.

import { assert, assertEquals } from "@std/assert";
import { FabricLink } from "@commonfabric/data-model/fabric-instances";
import { jsonFromValue } from "@commonfabric/data-model/codec-json";
import {
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";

import {
  annotate,
  collectLinks,
  decodedLinkOf,
  summarizeLink,
} from "../decode.ts";
import { decodeStored } from "../decode.ts";

Deno.test("decode: modern FabricLink is recognized as a link", () => {
  const link = new FabricLink({ id: "of:target", path: [] });
  const decoded = decodedLinkOf(link);
  assert(decoded, "FabricLink should be recognized");
  assertEquals(decoded!.id, "of:target");

  // and reachable via collectLinks when nested in a plain structure
  const links = collectLinks({ a: { b: link } });
  assertEquals(links.length, 1);
  assertEquals(links[0].id, "of:target");
});

Deno.test("decode: a modern fvj1-encoded link round-trips to a recognized link", () => {
  // Encode WITH modern cell rep on (as a modern server would), decode with the
  // inspector's default config — the value-at-rest must still read as a link.
  setModernCellRepConfig(true);
  let encoded: string;
  try {
    encoded = jsonFromValue({ value: { ref: new FabricLink({ id: "of:x" }) } });
  } finally {
    resetModernCellRepConfig();
  }
  const decoded = decodeStored(encoded) as { value: { ref: unknown } };
  const links = collectLinks(decoded);
  assert(links.some((l) => l.id === "of:x"), "modern link must be found");
  // and it must not throw when lowered for export
  JSON.stringify(annotate(decoded));
});

Deno.test("decode: summarizeLink keeps the computed: scheme visible", () => {
  const summary = (id: string) => summarizeLink({ id, hasSchema: false });
  // The hash preimage is kind-free, so of:fid1:H and computed:fid1:H can be
  // two distinct docs for one cause — the display must NOT conflate them.
  assert(
    summary("of:fid1:abcdefghijklmnop") !==
      summary("computed:fid1:abcdefghijklmnop"),
    "schemes must stay distinguishable",
  );
  assert(
    summary("computed:fid1:abcdefghijklmnop").includes("computed:"),
    "computed marker survives shortening",
  );
  assert(
    summary("computed:fid1:abcdefghijklmnop").includes("fid1:abc"),
    "hash body head survives",
  );
});

Deno.test("decode: BigInt and Fabric instances are JSON-safe after annotate", () => {
  const annotated = annotate({ big: 10n, nested: [1n, "ok"] }) as {
    big: { $bigint: string };
    nested: Array<unknown>;
  };
  assertEquals(annotated.big, { $bigint: "10" });
  // the whole thing must JSON.stringify without throwing (the HTML/CLI export path)
  const json = JSON.stringify(annotated);
  assert(json.includes('"$bigint"'), "bigint lowered to a tagged record");
});

Deno.test("decode: a present `undefined` is not silently dropped on export", () => {
  // JSON.stringify omits an `undefined` field; the sentinel preserves the
  // present-undefined vs absent-key distinction the data model keeps.
  const annotated = annotate({ a: undefined, b: 1 }) as Record<string, unknown>;
  assertEquals(annotated.a, { $undefined: true });
  assert(
    "a" in JSON.parse(JSON.stringify(annotated)),
    "the undefined field survives JSON round-trip",
  );
});
