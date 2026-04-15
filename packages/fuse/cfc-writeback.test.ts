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
  authorizeNamespaceMutationWriteback,
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
  operation:
    | "write"
    | "truncate"
    | "create"
    | "mkdir"
    | "unlink"
    | "rmdir"
    | "rename-source"
    | "rename-destination",
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

Deno.test("writeback prepare parsing accepts namespace operations only by exact name", () => {
  const { parentIno, ref } = makeAnnotatedTree();
  const store = new CfcWritebackStore();

  for (
    const operation of [
      "unlink",
      "rmdir",
      "rename-source",
      "rename-destination",
    ] as const
  ) {
    assertEquals(
      store.setPreparedXattr(
        parentIno,
        CFC_WRITEBACK_PREPARE_XATTR,
        prepareJson(operation, ref, { name: `${operation}-name` }),
      ).ok,
      true,
      operation,
    );
  }

  assertEquals(
    store.setPreparedXattr(
      parentIno,
      CFC_WRITEBACK_PREPARE_XATTR,
      prepareJson(
        "unlink",
        ref,
        { name: "bad", operation: "rename" },
      ).replace('"unlink"', '"rename"'),
    ).ok,
    false,
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

Deno.test("observe mode logs and allows missing namespace mutation prepare", () => {
  const { tree, parentIno } = makeAnnotatedTree();
  const diagnostics: string[] = [];

  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "observe",
      operation: "unlink",
      parentAnnotation: tree.getCfcAnnotation(parentIno),
      prepared: undefined,
      name: "missing-child",
      diagnostics,
    }).allowed,
    true,
  );
  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "observe",
      operation: "rename-source",
      parentAnnotation: tree.getCfcAnnotation(parentIno),
      prepared: undefined,
      name: "old",
      pairedName: "new",
      diagnostics,
    }).allowed,
    true,
  );
  assertStringIncludes(
    diagnostics.join("\n"),
    "missing prepared CFC writeback metadata",
  );
});

Deno.test("enforce-explicit requires namespace prepare only for annotated parents", () => {
  const { tree, parentIno } = makeAnnotatedTree();

  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "enforce-explicit",
      operation: "unlink",
      parentAnnotation: tree.getCfcAnnotation(parentIno),
      prepared: undefined,
      name: "title",
    }).allowed,
    false,
  );
  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "enforce-explicit",
      operation: "unlink",
      parentAnnotation: undefined,
      prepared: undefined,
      name: "ordinary",
    }).allowed,
    true,
  );
});

Deno.test("enforce-strict rejects missing malformed and stale namespace prepare", () => {
  const { tree, parentIno } = makeAnnotatedTree();
  const parentAnnotation = tree.getCfcAnnotation(parentIno);
  assertExists(parentAnnotation);

  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "enforce-strict",
      operation: "rmdir",
      parentAnnotation,
      prepared: undefined,
      name: "dir",
    }).allowed,
    false,
  );
  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "enforce-strict",
      operation: "rmdir",
      parentAnnotation,
      prepared: {
        version: 1,
        operation: "unlink",
        target: { parentRef: parentAnnotation.ref, name: "dir" },
        expectedGeneration: parentAnnotation.generation,
        labels: {},
      },
      name: "dir",
    }).allowed,
    false,
  );
  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "enforce-strict",
      operation: "rmdir",
      parentAnnotation,
      prepared: {
        version: 1,
        operation: "rmdir",
        target: { parentRef: parentAnnotation.ref, name: "other" },
        expectedGeneration: parentAnnotation.generation,
        labels: {},
      },
      name: "dir",
    }).allowed,
    false,
  );
  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "enforce-strict",
      operation: "rmdir",
      parentAnnotation,
      prepared: {
        version: 1,
        operation: "rmdir",
        target: { parentRef: parentAnnotation.ref, name: "dir" },
        expectedGeneration: "stale-generation",
        labels: {},
      },
      name: "dir",
    }).allowed,
    false,
  );
});

Deno.test("namespace prepare gates before occupancy-sensitive lookup", () => {
  const { tree, parentIno } = makeAnnotatedTree();
  const parentAnnotation = tree.getCfcAnnotation(parentIno);
  assertExists(parentAnnotation);

  const result = authorizeNamespaceMutationWriteback({
    mode: "enforce-strict",
    operation: "unlink",
    parentAnnotation,
    prepared: undefined,
    name: "does-not-exist",
  });

  assertEquals(result.allowed, false);
  if (result.allowed) throw new Error("expected namespace writeback rejection");
  assertStringIncludes(result.reason, "prepared CFC writeback metadata");
});

Deno.test("rename prepare validation binds source and destination parent generations and names", () => {
  const { tree, parentIno } = makeAnnotatedTree();
  const destinationParentIno = tree.addDir(tree.rootIno, "other", "object");
  const parentAnnotation = tree.getCfcAnnotation(parentIno);
  assertExists(parentAnnotation);
  tree.setCfcAnnotation(destinationParentIno, {
    ...parentAnnotation,
    ref: {
      ...parentAnnotation.ref,
      path: ["other"],
      generation: "generation-2",
    },
    generation: "generation-2",
  });
  const destinationAnnotation = tree.getCfcAnnotation(destinationParentIno);
  assertExists(destinationAnnotation);

  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "enforce-strict",
      operation: "rename-source",
      parentAnnotation,
      prepared: {
        version: 1,
        operation: "rename-source",
        target: {
          parentRef: parentAnnotation.ref,
          name: "title",
          sourceName: "title",
          destinationName: "renamed",
        },
        expectedGeneration: parentAnnotation.generation,
        labels: {},
      },
      name: "title",
      pairedName: "renamed",
    }).allowed,
    true,
  );
  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "enforce-strict",
      operation: "rename-destination",
      parentAnnotation: destinationAnnotation,
      prepared: {
        version: 1,
        operation: "rename-destination",
        target: {
          parentRef: destinationAnnotation.ref,
          name: "renamed",
          sourceName: "title",
          destinationName: "renamed",
        },
        expectedGeneration: destinationAnnotation.generation,
        labels: {},
      },
      name: "renamed",
      pairedName: "title",
    }).allowed,
    true,
  );
  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "enforce-strict",
      operation: "rename-destination",
      parentAnnotation: destinationAnnotation,
      prepared: {
        version: 1,
        operation: "rename-destination",
        target: {
          parentRef: parentAnnotation.ref,
          name: "renamed",
          sourceName: "title",
          destinationName: "renamed",
        },
        expectedGeneration: parentAnnotation.generation,
        labels: {},
      },
      name: "renamed",
      pairedName: "title",
    }).allowed,
    false,
  );
  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "enforce-strict",
      operation: "rename-destination",
      parentAnnotation: destinationAnnotation,
      prepared: {
        version: 1,
        operation: "rename-destination",
        target: {
          parentRef: destinationAnnotation.ref,
          name: "other",
          sourceName: "title",
          destinationName: "other",
        },
        expectedGeneration: destinationAnnotation.generation,
        labels: {},
      },
      name: "renamed",
      pairedName: "title",
    }).allowed,
    false,
  );
});

Deno.test("same-parent rename can use one prepare record covering both names", () => {
  const { tree, parentIno } = makeAnnotatedTree();
  const parentAnnotation = tree.getCfcAnnotation(parentIno);
  assertExists(parentAnnotation);
  const prepared = {
    version: 1 as const,
    operation: "rename-source" as const,
    target: {
      sourceParentRef: parentAnnotation.ref,
      name: "title",
      destinationName: "renamed",
    },
    expectedGeneration: parentAnnotation.generation,
    labels: {},
  };

  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "enforce-strict",
      operation: "rename-source",
      parentAnnotation,
      prepared,
      name: "title",
      pairedName: "renamed",
      allowPairedRenamePrepare: true,
    }).allowed,
    true,
  );
  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "enforce-strict",
      operation: "rename-destination",
      parentAnnotation,
      prepared,
      name: "renamed",
      pairedName: "title",
      allowPairedRenamePrepare: true,
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
