import { assert, assertEquals } from "@std/assert";
import { parseDocument, SAMPLE } from "./view-helpers.ts";
import {
  ancestorsOf,
  findDependencies,
  findReferences,
} from "../lib/view/references.ts";

Deno.test("findReferences: declaration plus call site, with inside flag", () => {
  const doc = parseDocument(SAMPLE);
  const lift = doc.flatStructure.find((n) => n.label === "lift __cfLift_1")!;
  const refs = findReferences(doc, "__cfLift_1", lift);
  assert(refs.length >= 2, `expected ≥2 occurrences, got ${refs.length}`);
  // the declaration is inside the lift node's range
  assert(refs.some((r) => r.inside), "declaration occurrence flagged inside");
  // the call site is outside (inside myPattern)
  const outside = refs.filter((r) => !r.inside);
  assert(outside.length >= 1, "a call site outside the declaration");
  assert(
    outside.some((r) => r.lineText.includes("__cfLift_1({")),
    "call-site context captured",
  );
});

Deno.test("findReferences: ignores non-identifier occurrences", () => {
  const doc = parseDocument(SAMPLE);
  // "token" appears as a schema key (schemaKey) and as identifiers; references
  // should only pick identifier-role spans, not schema/property keys.
  const refs = findReferences(doc, "token");
  for (const r of refs) {
    assert(
      r.cls !== "schemaKey" && r.cls !== "propertyName",
      `unexpected key-role reference: ${r.cls}`,
    );
  }
});

Deno.test("findDependencies: pattern depends on the hoisted lift", () => {
  const doc = parseDocument(SAMPLE);
  const p = doc.flatStructure.find((n) => n.label === "pattern myPattern")!;
  const deps = findDependencies(doc, p);
  assert(
    deps.some((d) => d.name === "__cfLift_1"),
    `expected dependency on __cfLift_1, got ${deps.map((d) => d.name)}`,
  );
  const dep = deps.find((d) => d.name === "__cfLift_1")!;
  assertEquals(dep.kind, "builder");
});

Deno.test("findDependencies: excludes the node's own declarations", () => {
  const doc = parseDocument(SAMPLE);
  const p = doc.flatStructure.find((n) => n.label === "pattern myPattern")!;
  const deps = findDependencies(doc, p);
  // `t` and `url` are declared inside the pattern, not dependencies.
  assert(!deps.some((d) => d.name === "t"), "local binding t is not a dep");
});

Deno.test("ancestorsOf: chain from section down to the parent", () => {
  const doc = parseDocument(SAMPLE);
  const closure = doc.flatStructure.find((n) =>
    n.kind === "closure" && n.depth >= 2
  )!;
  const chain = ancestorsOf(doc.flatStructure, closure);
  assert(chain.length >= 1, "has ancestors");
  // ordered outermost → innermost, strictly increasing depth
  for (let i = 1; i < chain.length; i++) {
    assert(
      chain[i].depth > chain[i - 1].depth,
      "depth increases down the chain",
    );
  }
  // first ancestor is a section, last is shallower than the node
  assertEquals(chain[0].kind, "section");
  assert(chain[chain.length - 1].depth < closure.depth);
});

Deno.test("ancestorsOf: a root node has no ancestors", () => {
  const doc = parseDocument(SAMPLE);
  const section = doc.flatStructure.find((n) => n.kind === "section")!;
  assertEquals(ancestorsOf(doc.flatStructure, section).length, 0);
});
