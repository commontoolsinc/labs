import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { FsTree } from "./tree.ts";
import {
  CfcProjectionAnnotator,
  type CfcProjectionRef,
} from "./annotations.ts";
import {
  applyPreparedCreate,
  applyPreparedExistingWrite,
  authorizeCreateWriteback,
  authorizeExistingWriteback,
  CFC_WRITEBACK_FINALIZE_XATTR,
  CFC_WRITEBACK_PREPARE_XATTR,
  CfcWritebackStore,
  parseCfcMode,
  resolveCfcMode,
  shouldEnableCfcAnnotations,
} from "./cfc-writeback.ts";

const SECRET_LABEL = {
  confidentiality: [{ type: "test-label", value: "secret" }],
};

function makeAnnotatedTree(): {
  tree: FsTree;
  parentIno: bigint;
  fileIno: bigint;
  ref: CfcProjectionRef;
} {
  const tree = new FsTree();
  const annotator = new CfcProjectionAnnotator(tree, {
    space: "did:key:zSpace",
    entity: "of:piece",
    rootKind: "pieces",
    cell: "result",
    generation: "generation-1",
    labelView: {
      version: 1,
      entries: [{ path: ["title"], label: SECRET_LABEL }],
    },
  });
  const parentIno = tree.addDir(tree.rootIno, "result", "object");
  annotator.annotateJsonDirectory(parentIno, [], { title: "old" });
  const fileIno = tree.addFile(parentIno, "title", "old", "string");
  annotator.annotateJsonScalar(fileIno, ["title"], "old");
  annotator.annotateEntry(parentIno, "title", fileIno, {
    labelPath: ["title"],
  });
  const ref = tree.getCfcAnnotation(fileIno)?.ref;
  assertExists(ref);
  return { tree, parentIno, fileIno, ref };
}

function prepareJson(
  operation: "write" | "truncate" | "create" | "mkdir",
  ref: CfcProjectionRef,
  extraTarget: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    version: 1,
    operation,
    target: { ref, ...extraTarget },
    expectedGeneration: ref.generation,
    labels: {
      contentLabel: SECRET_LABEL,
      nameLabel: SECRET_LABEL,
      existenceLabel: SECRET_LABEL,
      namespaceLabel: SECRET_LABEL,
      metadataLabels: { type: SECRET_LABEL },
    },
  });
}

Deno.test("CFC mode parsing and annotation defaults match runner modes", () => {
  assertEquals(parseCfcMode("disabled"), "disabled");
  assertEquals(parseCfcMode("observe"), "observe");
  assertEquals(parseCfcMode("enforce-explicit"), "enforce-explicit");
  assertEquals(parseCfcMode("enforce-strict"), "enforce-strict");
  assertEquals(parseCfcMode("bogus"), undefined);

  assertEquals(
    resolveCfcMode({ cliMode: "observe", envMode: "enforce-strict" }),
    "observe",
  );
  assertEquals(
    resolveCfcMode({ cliMode: undefined, envMode: "enforce-explicit" }),
    "enforce-explicit",
  );
  assertEquals(resolveCfcMode({}), "disabled");

  assertEquals(
    shouldEnableCfcAnnotations({
      annotationsRequested: false,
      mode: "disabled",
    }),
    false,
  );
  assertEquals(
    shouldEnableCfcAnnotations({
      annotationsRequested: true,
      mode: "disabled",
    }),
    true,
  );
  assertEquals(
    shouldEnableCfcAnnotations({
      annotationsRequested: false,
      mode: "observe",
    }),
    true,
  );
});

Deno.test("observe mode logs and allows missing prepared writeback metadata", () => {
  const { tree, fileIno } = makeAnnotatedTree();
  const diagnostics: string[] = [];

  const result = authorizeExistingWriteback({
    mode: "observe",
    operation: "write",
    annotation: tree.getCfcAnnotation(fileIno),
    prepared: undefined,
    diagnostics,
  });

  assertEquals(result.allowed, true);
  assertEquals(result.requiresPrepare, false);
  assertStringIncludes(
    diagnostics.join("\n"),
    "missing prepared CFC writeback",
  );
});

Deno.test("enforce-explicit blocks annotated writes but allows unannotated paths", () => {
  const { tree, fileIno } = makeAnnotatedTree();

  assertEquals(
    authorizeExistingWriteback({
      mode: "enforce-explicit",
      operation: "write",
      annotation: tree.getCfcAnnotation(fileIno),
      prepared: undefined,
    }).allowed,
    false,
  );
  assertEquals(
    authorizeExistingWriteback({
      mode: "enforce-explicit",
      operation: "write",
      annotation: undefined,
      prepared: undefined,
    }).allowed,
    true,
  );
});

Deno.test("enforce-strict blocks missing, malformed, and stale writeback state", () => {
  const { tree, fileIno, ref } = makeAnnotatedTree();
  const annotation = tree.getCfcAnnotation(fileIno);

  assertEquals(
    authorizeExistingWriteback({
      mode: "enforce-strict",
      operation: "write",
      annotation: undefined,
      prepared: undefined,
    }).allowed,
    false,
  );

  assertEquals(
    authorizeExistingWriteback({
      mode: "enforce-strict",
      operation: "write",
      annotation,
      prepared: {
        version: 1,
        operation: "create",
        target: { ref },
        expectedGeneration: ref.generation,
        labels: {},
      },
    }).allowed,
    false,
  );

  assertEquals(
    authorizeExistingWriteback({
      mode: "enforce-strict",
      operation: "write",
      annotation,
      prepared: {
        version: 1,
        operation: "write",
        target: { ref },
        expectedGeneration: "stale-generation",
        labels: {},
      },
    }).allowed,
    false,
  );
});

Deno.test("prepared existing-file write applies conservative labels and can remain after failure", () => {
  const { tree, fileIno, ref } = makeAnnotatedTree();
  const store = new CfcWritebackStore();
  const prepared = store.setPreparedXattr(
    fileIno,
    CFC_WRITEBACK_PREPARE_XATTR,
    prepareJson("write", ref),
  );
  assertEquals(prepared.ok, true);

  const authorization = authorizeExistingWriteback({
    mode: "enforce-strict",
    operation: "write",
    annotation: tree.getCfcAnnotation(fileIno),
    prepared: store.getPrepared(fileIno, "write"),
  });
  assertEquals(authorization.allowed, true);
  if (!authorization.allowed) throw new Error(authorization.reason);
  assertExists(authorization.prepared);
  applyPreparedExistingWrite(tree, fileIno, authorization.prepared);

  const annotation = tree.getCfcAnnotation(fileIno);
  assertExists(annotation);
  assertStringIncludes(annotation.generation, "prepared:sha256:");
  assertEquals(annotation.contentLabel, SECRET_LABEL);

  // No finalize call simulates runner write failure after prepare: the
  // conservative prepared annotation remains in place.
  assertStringIncludes(tree.getCfcAnnotation(fileIno)!.generation, "prepared:");
});

Deno.test("parent-prepared create and mkdir gate occupancy-sensitive paths", () => {
  const { tree, parentIno } = makeAnnotatedTree();
  const parentAnnotation = tree.getCfcAnnotation(parentIno);
  assertExists(parentAnnotation);

  tree.addFile(parentIno, "occupied", "hidden", "string");

  assertEquals(
    authorizeCreateWriteback({
      mode: "enforce-strict",
      operation: "create",
      parentAnnotation,
      prepared: undefined,
      name: "occupied",
    }).allowed,
    false,
  );

  const store = new CfcWritebackStore();
  const parentRef = parentAnnotation.ref;
  const prepared = store.setPreparedXattr(
    parentIno,
    CFC_WRITEBACK_PREPARE_XATTR,
    prepareJson("create", parentRef, { name: "fresh" }),
  );
  assertEquals(prepared.ok, true);
  const authorization = authorizeCreateWriteback({
    mode: "enforce-strict",
    operation: "create",
    parentAnnotation,
    prepared: store.getPrepared(parentIno, "create", "fresh"),
    name: "fresh",
  });
  assertEquals(authorization.allowed, true);
  if (!authorization.allowed) throw new Error(authorization.reason);
  assertExists(authorization.prepared);

  applyPreparedCreate(tree, parentIno, "fresh", "file", authorization.prepared);
  const childIno = tree.lookup(parentIno, "fresh");
  assertExists(childIno);
  assertStringIncludes(
    tree.getCfcAnnotation(parentIno)!.generation,
    "prepared:",
  );
  assertStringIncludes(
    tree.getCfcAnnotation(childIno)!.generation,
    "prepared:",
  );

  const preparedParentRef = tree.getCfcAnnotation(parentIno)!.ref;
  const mkdirPrepared = store.setPreparedXattr(
    parentIno,
    CFC_WRITEBACK_PREPARE_XATTR,
    prepareJson("mkdir", preparedParentRef, { name: "dir" }),
  );
  assertEquals(mkdirPrepared.ok, true);
  assertEquals(
    authorizeCreateWriteback({
      mode: "enforce-strict",
      operation: "mkdir",
      parentAnnotation: tree.getCfcAnnotation(parentIno),
      prepared: store.getPrepared(parentIno, "mkdir", "dir"),
      name: "dir",
    }).allowed,
    true,
  );
});

Deno.test("writeback xattrs accept trusted prepare/finalize names only", () => {
  const { fileIno, ref } = makeAnnotatedTree();
  const store = new CfcWritebackStore();

  assertEquals(
    store.setPreparedXattr(
      fileIno,
      "user.commonfabric.cfc.writeback.prepare",
      prepareJson("write", ref),
    ).ok,
    false,
  );
  assertEquals(
    store.setPreparedXattr(fileIno, CFC_WRITEBACK_PREPARE_XATTR, "{").ok,
    false,
  );
  assertEquals(
    store.setPreparedXattr(
      fileIno,
      CFC_WRITEBACK_PREPARE_XATTR,
      prepareJson("write", ref),
    ).ok,
    true,
  );
  assertExists(store.getPrepared(fileIno, "write"));
  assertEquals(
    store.setFinalizeXattr(
      fileIno,
      CFC_WRITEBACK_FINALIZE_XATTR,
      JSON.stringify({
        version: 1,
        operation: "write",
        committedGeneration: "generation-2",
      }),
    ).ok,
    true,
  );
  assertEquals(store.getPrepared(fileIno, "write"), undefined);
});
