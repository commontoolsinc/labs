import { assert, assertEquals, assertExists } from "@std/assert";
import { buildCallableScript } from "./callables.ts";
import {
  CFC_COMPAT_XATTR_PREFIX,
  CFC_FAIL_CLOSED_ATOM_CLASS,
  CfcProjectionAnnotator,
  getCfcXattrValue,
  listCfcXattrNames,
} from "./annotations.ts";
import { FsTree } from "./tree.ts";
import { buildJsonTree } from "./tree-builder.ts";

const decoder = new TextDecoder();

const TITLE_LABEL = {
  confidentiality: [{ type: "test-label", value: "title" }],
};
const BODY_LABEL = {
  confidentiality: [{ type: "test-label", value: "body" }],
};
const LINK_LABEL = {
  confidentiality: [{ type: "test-label", value: "link" }],
};
const SCHEMA_LABEL = {
  confidentiality: [{ type: "test-label", value: "schema" }],
};

function makeAnnotator(
  tree: FsTree,
  entries: Array<{
    path: string[];
    label: { confidentiality?: unknown[]; integrity?: unknown[] };
  }> = [],
): CfcProjectionAnnotator {
  return new CfcProjectionAnnotator(tree, {
    space: "did:key:zSpace",
    entity: "of:entity-123",
    rootKind: "pieces",
    cell: "result",
    generation: "generation-1",
    labelView: { version: 1, entries },
  });
}

function inoAt(tree: FsTree, path: string[]): bigint {
  let ino = tree.rootIno;
  for (const part of path) {
    const next = tree.lookup(ino, part);
    if (next === undefined) {
      throw new Error(`Missing path segment ${part} in /${path.join("/")}`);
    }
    ino = next;
  }
  return ino;
}

function annotationJson(
  tree: FsTree,
  ino: bigint,
  name: string,
): unknown {
  const value = getCfcXattrValue(tree, ino, name, {
    enabled: true,
    namespace: "compat",
  });
  assertExists(value);
  return JSON.parse(decoder.decode(value));
}

Deno.test("CFC annotations use stable refs independent of transient inodes", () => {
  const data = { items: [{ text: "one" }] };
  const labels = [
    { path: ["items", "0", "text"], label: TITLE_LABEL },
  ];

  const firstTree = new FsTree();
  const firstAnnotator = makeAnnotator(firstTree, labels);
  buildJsonTree(
    firstTree,
    firstTree.rootIno,
    "result",
    data,
    undefined,
    undefined,
    0,
    undefined,
    undefined,
    firstAnnotator.jsonContext([]),
  );
  const firstTextIno = inoAt(firstTree, ["result", "items", "0", "text"]);
  const firstRef = firstTree.getCfcAnnotation(firstTextIno)?.ref;

  const secondTree = new FsTree();
  secondTree.addFile(secondTree.rootIno, "unrelated", "x", "string");
  const secondAnnotator = makeAnnotator(secondTree, labels);
  buildJsonTree(
    secondTree,
    secondTree.rootIno,
    "result",
    data,
    undefined,
    undefined,
    0,
    undefined,
    undefined,
    secondAnnotator.jsonContext([]),
  );
  const secondTextIno = inoAt(secondTree, ["result", "items", "0", "text"]);
  const secondRef = secondTree.getCfcAnnotation(secondTextIno)?.ref;

  assert(firstTextIno !== secondTextIno);
  assertEquals(firstRef, secondRef);
});

Deno.test("CFC aggregate JSON annotations join descendant labels", () => {
  const tree = new FsTree();
  const annotator = makeAnnotator(tree, [
    { path: ["title"], label: TITLE_LABEL },
    { path: ["nested", "body"], label: BODY_LABEL },
  ]);

  buildJsonTree(
    tree,
    tree.rootIno,
    "result",
    { title: "hello", nested: { body: "secret" } },
    undefined,
    undefined,
    0,
    undefined,
    undefined,
    annotator.jsonContext([]),
  );

  const resultJsonIno = inoAt(tree, ["result.json"]);
  const label = tree.getCfcAnnotation(resultJsonIno)?.contentLabel;
  assertEquals(label?.confidentiality, [
    TITLE_LABEL.confidentiality![0],
    BODY_LABEL.confidentiality![0],
  ]);
});

Deno.test("CFC directory entries include child refs and entry labels", () => {
  const tree = new FsTree();
  const annotator = makeAnnotator(tree, [
    { path: ["title"], label: TITLE_LABEL },
  ]);

  buildJsonTree(
    tree,
    tree.rootIno,
    "result",
    { title: "hello" },
    undefined,
    undefined,
    0,
    undefined,
    undefined,
    annotator.jsonContext([]),
  );

  const resultIno = inoAt(tree, ["result"]);
  const titleIno = inoAt(tree, ["result", "title"]);
  const entries = tree.getCfcAnnotation(resultIno)?.entries?.entries ?? [];
  const titleEntry = entries.find((entry) => entry.name === "title");
  assertExists(titleEntry);
  assertEquals(titleEntry.kind, "file");
  assertEquals(titleEntry.childRef, tree.getCfcAnnotation(titleIno)?.ref);
  assertEquals(titleEntry.nameLabel, TITLE_LABEL);
  assertEquals(titleEntry.existenceLabel, TITLE_LABEL);
  assertExists(titleEntry.metadataLabels.size);
});

Deno.test("CFC symlink annotations include link text and target metadata", () => {
  const tree = new FsTree();
  const annotator = makeAnnotator(tree, [
    { path: ["ref"], label: LINK_LABEL },
  ]);

  buildJsonTree(
    tree,
    tree.rootIno,
    "result",
    { ref: { "/": { "link@1": { id: "of:target" } } } },
    undefined,
    () => "../../../entities/of:target",
    0,
    undefined,
    undefined,
    annotator.jsonContext([]),
  );

  const linkIno = inoAt(tree, ["result", "ref"]);
  const annotation = tree.getCfcAnnotation(linkIno);
  assertExists(annotation);
  assertEquals(annotation.ref.projection, "symlink");
  assertEquals(annotation.symlink?.target, "../../../entities/of:target");
  assertEquals(annotation.symlink?.linkTextLabel, LINK_LABEL);
  assertEquals(
    annotation.contentLabel?.confidentiality?.[0],
    LINK_LABEL.confidentiality![0],
  );
});

Deno.test("CFC callable annotations separate descriptor bytes from invocation authority", () => {
  const tree = new FsTree();
  const annotator = makeAnnotator(tree);
  const resultIno = tree.addDir(tree.rootIno, "result", "object");
  annotator.annotateJsonDirectory(resultIno, [], {});

  const callableIno = tree.addCallable(
    resultIno,
    "search.tool",
    "tool",
    "search",
    "result",
    buildCallableScript("/tmp/cf-exec", undefined, "string"),
  );
  annotator.annotateCallable(callableIno, ["search"], {
    callableKind: "tool",
    cellKey: "search",
    cellProp: "result",
    schemaLabel: SCHEMA_LABEL,
  });

  const annotation = tree.getCfcAnnotation(callableIno);
  assertExists(annotation);
  assertEquals(annotation.ref.projection, "callable");
  assertEquals(
    annotation.callable?.descriptor.contentLabel,
    annotation.contentLabel,
  );
  assertEquals(
    annotation.callable?.invocation.boundary,
    "common-fabric-runtime",
  );
  assertEquals(
    annotation.callable?.invocation.authority,
    "not-conveyed-by-file-bytes",
  );
  assertEquals(annotation.callable?.schemaLabel, SCHEMA_LABEL);
});

Deno.test("CFC annotations fail closed when runner path metadata is missing", () => {
  const tree = new FsTree();
  const annotator = makeAnnotator(tree);

  buildJsonTree(
    tree,
    tree.rootIno,
    "result",
    { title: "hello" },
    undefined,
    undefined,
    0,
    undefined,
    undefined,
    annotator.jsonContext([]),
  );

  const titleIno = inoAt(tree, ["result", "title"]);
  const label = tree.getCfcAnnotation(titleIno)?.contentLabel;
  assert(
    JSON.stringify(label).includes(CFC_FAIL_CLOSED_ATOM_CLASS),
    "missing labels must carry the fail-closed CFC caveat",
  );
});

Deno.test("CFC xattr compatibility namespace is opt-in", () => {
  const tree = new FsTree();
  const annotator = makeAnnotator(tree, [
    { path: ["title"], label: TITLE_LABEL },
  ]);

  buildJsonTree(
    tree,
    tree.rootIno,
    "result",
    { title: "hello" },
    undefined,
    undefined,
    0,
    undefined,
    undefined,
    annotator.jsonContext([]),
  );

  const titleIno = inoAt(tree, ["result", "title"]);
  assertEquals(
    listCfcXattrNames(tree, titleIno, { enabled: false, namespace: "compat" }),
    [],
  );

  const names = listCfcXattrNames(tree, titleIno, {
    enabled: true,
    namespace: "compat",
  });
  assert(names.includes(`${CFC_COMPAT_XATTR_PREFIX}ref`));

  const ref = annotationJson(tree, titleIno, `${CFC_COMPAT_XATTR_PREFIX}ref`);
  assertEquals((ref as { projection?: string }).projection, "value");
});
