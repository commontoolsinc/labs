import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { fromFileUrl } from "@std/path/from-file-url";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type {
  NativeStorageCommit,
  Result,
  StorageTransactionRejected,
  Unit,
} from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("memory-v2-native-commit");
const space = signer.did();
const type = "application/json" as const;

const captureNativeDrafts = () => {
  const storage = StorageManager.emulate({
    as: signer,
    memoryVersion: "v2",
  });
  const provider = storage.open(space);
  const replica = provider.replica as typeof provider.replica & {
    commitNative(
      transaction: NativeStorageCommit,
      source?: unknown,
    ): Promise<Result<Unit, StorageTransactionRejected>>;
    commit(
      transaction: unknown,
      source?: unknown,
    ): Promise<Result<Unit, StorageTransactionRejected>>;
  };
  const originalCommitNative = replica.commitNative?.bind(replica);
  assertExists(originalCommitNative);

  const drafts: NativeStorageCommit[] = [];
  replica.commit = () =>
    Promise.reject(new Error("legacy commit path should not be used"));
  replica.commitNative = async (transaction, source) => {
    drafts.push(structuredClone(transaction));
    return await originalCommitNative(transaction, source);
  };

  return { storage, drafts };
};

Deno.test("memory v2 transactions use the native commit hook when available", async () => {
  const { storage, drafts } = captureNativeDrafts();

  try {
    const tx = storage.edit();
    const writeResult = tx.write({
      space,
      id: "of:memory-v2-native-commit",
      type,
      path: [],
    }, { value: { count: 1 } });
    assert(writeResult.ok);

    const commitResult = await tx.commit();
    assert(commitResult.ok);
    assertEquals(drafts, [{
      operations: [{
        op: "set",
        id: "of:memory-v2-native-commit",
        type,
        value: { value: { count: 1 } },
      }],
    }]);

    const verify = storage.edit();
    const readResult = verify.read({
      space,
      id: "of:memory-v2-native-commit",
      type,
      path: ["value"],
    });
    assertEquals(readResult.ok?.value, { count: 1 });
  } finally {
    await storage.close();
  }
});

Deno.test("memory v2 native commits require explicit full-document roots", async () => {
  const storage = StorageManager.emulate({
    as: signer,
    memoryVersion: "v2",
  });

  try {
    const provider = storage.open(space);
    const replica = provider.replica as typeof provider.replica & {
      commitNative(
        transaction: NativeStorageCommit,
        source?: unknown,
      ): Promise<Result<Unit, StorageTransactionRejected>>;
    };

    await assertRejects(
      () =>
        replica.commitNative({
          operations: [{
            op: "set",
            id: "of:memory-v2-invalid-root",
            type,
            value: "not-a-document",
          }],
        }),
      Error,
      "memory v2 transactions require explicit full-document roots",
    );
  } finally {
    await storage.close();
  }
});

Deno.test("memory v2 transactions emit patch drafts for safe object-path writes", async () => {
  const { storage, drafts } = captureNativeDrafts();

  try {
    const seed = storage.edit();
    const seedWrite = seed.write({
      space,
      id: "of:memory-v2-native-patch",
      type,
      path: [],
    }, { value: { profile: { name: "Ada", title: "Dr" } } });
    assert(seedWrite.ok);
    const seedCommit = await seed.commit();
    assert(seedCommit.ok);

    drafts.length = 0;

    const tx = storage.edit();
    const writeResult = tx.write({
      space,
      id: "of:memory-v2-native-patch",
      type,
      path: ["value", "profile", "name"],
    }, "Grace");
    assert(writeResult.ok);

    const commitResult = await tx.commit();
    assert(commitResult.ok);
    assertEquals(drafts, [{
      operations: [{
        op: "patch",
        id: "of:memory-v2-native-patch",
        type,
        value: { value: { profile: { name: "Grace", title: "Dr" } } },
        patches: [{
          op: "replace",
          path: "/value/profile/name",
          value: "Grace",
        }],
      }],
    }]);
  } finally {
    await storage.close();
  }
});

Deno.test("memory v2 transactions emit set drafts for leaf writes into new documents", async () => {
  const { storage, drafts } = captureNativeDrafts();

  try {
    const tx = storage.edit();
    const batchWrite = tx.writeBatch?.([
      {
        address: {
          space,
          id: "of:memory-v2-native-create-via-patch",
          type,
          path: ["value", "profile", "name"],
        },
        value: "Ada",
      },
    ]);
    assert(batchWrite?.ok);

    const commitResult = await tx.commit();
    assert(commitResult.ok);
    assertEquals(drafts, [{
      operations: [{
        op: "set",
        id: "of:memory-v2-native-create-via-patch",
        type,
        value: { value: { profile: { name: "Ada" } } },
      }],
    }]);
  } finally {
    await storage.close();
  }
});

Deno.test("memory v2 transactions emit add and remove patch drafts for safe object-path writes", async () => {
  const { storage, drafts } = captureNativeDrafts();

  try {
    const seed = storage.edit();
    const seedWrite = seed.write({
      space,
      id: "of:memory-v2-native-add-remove",
      type,
      path: [],
    }, { value: { profile: { name: "Ada", title: "Dr" } } });
    assert(seedWrite.ok);
    const seedCommit = await seed.commit();
    assert(seedCommit.ok);

    drafts.length = 0;

    const addTx = storage.edit();
    const addWrite = addTx.write({
      space,
      id: "of:memory-v2-native-add-remove",
      type,
      path: ["value", "profile", "subtitle"],
    }, "Analyst");
    assert(addWrite.ok);
    const addCommit = await addTx.commit();
    assert(addCommit.ok);
    assertEquals(drafts, [{
      operations: [{
        op: "patch",
        id: "of:memory-v2-native-add-remove",
        type,
        value: {
          value: { profile: { name: "Ada", title: "Dr", subtitle: "Analyst" } },
        },
        patches: [{
          op: "add",
          path: "/value/profile/subtitle",
          value: "Analyst",
        }],
      }],
    }]);

    drafts.length = 0;

    const removeTx = storage.edit();
    const removeWrite = removeTx.write({
      space,
      id: "of:memory-v2-native-add-remove",
      type,
      path: ["value", "profile", "title"],
    }, undefined);
    assert(removeWrite.ok);
    const removeCommit = await removeTx.commit();
    assert(removeCommit.ok);
    assertEquals(drafts, [{
      operations: [{
        op: "patch",
        id: "of:memory-v2-native-add-remove",
        type,
        value: { value: { profile: { name: "Ada", subtitle: "Analyst" } } },
        patches: [{
          op: "remove",
          path: "/value/profile/title",
        }],
      }],
    }]);
  } finally {
    await storage.close();
  }
});

Deno.test("memory v2 transactions emit index patch drafts for dense array element writes", async () => {
  const { storage, drafts } = captureNativeDrafts();

  try {
    const seed = storage.edit();
    const seedWrite = seed.write({
      space,
      id: "of:memory-v2-native-array",
      type,
      path: [],
    }, { value: { tags: ["one", "two"] } });
    assert(seedWrite.ok);
    const seedCommit = await seed.commit();
    assert(seedCommit.ok);

    drafts.length = 0;

    const tx = storage.edit();
    const writeResult = tx.write({
      space,
      id: "of:memory-v2-native-array",
      type,
      path: ["value", "tags", "0"],
    }, "zero");
    assert(writeResult.ok);

    const commitResult = await tx.commit();
    assert(commitResult.ok);
    assertEquals(drafts, [{
      operations: [{
        op: "patch",
        id: "of:memory-v2-native-array",
        type,
        value: { value: { tags: ["zero", "two"] } },
        patches: [{
          op: "replace",
          path: "/value/tags/0",
          value: "zero",
        }],
      }],
    }]);
  } finally {
    await storage.close();
  }
});

Deno.test("memory v2 transactions emit splice patch drafts for dense array append writes", async () => {
  const { storage, drafts } = captureNativeDrafts();

  try {
    const seed = storage.edit();
    const seedWrite = seed.write({
      space,
      id: "of:memory-v2-native-array-append",
      type,
      path: [],
    }, { value: { tags: ["one", "two"] } });
    assert(seedWrite.ok);
    const seedCommit = await seed.commit();
    assert(seedCommit.ok);

    drafts.length = 0;

    const tx = storage.edit();
    const writeResult = tx.write({
      space,
      id: "of:memory-v2-native-array-append",
      type,
      path: ["value", "tags", "2"],
    }, "three");
    assert(writeResult.ok);

    const commitResult = await tx.commit();
    assert(commitResult.ok);
    assertEquals(drafts, [{
      operations: [{
        op: "patch",
        id: "of:memory-v2-native-array-append",
        type,
        value: { value: { tags: ["one", "two", "three"] } },
        patches: [{
          op: "splice",
          path: "/value/tags",
          index: 2,
          remove: 0,
          add: ["three"],
        }],
      }],
    }]);
  } finally {
    await storage.close();
  }
});

Deno.test("memory v2 transactions drop same-tx add-then-remove paths from patch drafts", async () => {
  const { storage, drafts } = captureNativeDrafts();

  try {
    const seed = storage.edit();
    const seedWrite = seed.write({
      space,
      id: "of:memory-v2-native-elide-noop-remove",
      type,
      path: [],
    }, { value: { profile: { name: "Ada" } } });
    assert(seedWrite.ok);
    const seedCommit = await seed.commit();
    assert(seedCommit.ok);

    drafts.length = 0;

    const tx = storage.edit();
    const addWrite = tx.write({
      space,
      id: "of:memory-v2-native-elide-noop-remove",
      type,
      path: ["value", "profile", "subtitle"],
    }, "Analyst");
    assert(addWrite.ok);
    const removeWrite = tx.write({
      space,
      id: "of:memory-v2-native-elide-noop-remove",
      type,
      path: ["value", "profile", "subtitle"],
    }, undefined);
    assert(removeWrite.ok);
    const renameWrite = tx.write({
      space,
      id: "of:memory-v2-native-elide-noop-remove",
      type,
      path: ["value", "profile", "name"],
    }, "Grace");
    assert(renameWrite.ok);

    const commitResult = await tx.commit();
    assert(commitResult.ok);
    assertEquals(drafts, [{
      operations: [{
        op: "patch",
        id: "of:memory-v2-native-elide-noop-remove",
        type,
        value: { value: { profile: { name: "Grace" } } },
        patches: [{
          op: "replace",
          path: "/value/profile/name",
          value: "Grace",
        }],
      }],
    }]);

    const verify = storage.edit();
    const readResult = verify.read({
      space,
      id: "of:memory-v2-native-elide-noop-remove",
      type,
      path: ["value"],
    });
    assertEquals(readResult.ok?.value, { profile: { name: "Grace" } });
  } finally {
    await storage.close();
  }
});

Deno.test("memory v2 transactions elide transient nested patches from composed handler drafts", async () => {
  const { storage, drafts } = captureNativeDrafts();
  const runtimeErrors: Error[] = [];
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    memoryVersion: "v2",
    errorHandlers: [(error) => runtimeErrors.push(error)],
  });

  const splitPath = (path: string): (string | number)[] =>
    path.split(".")
      .filter((segment) => segment.length > 0)
      .map((segment) => {
        const index = Number(segment);
        return Number.isInteger(index) && index.toString() === segment
          ? index
          : segment;
      });

  try {
    const modulePath = new URL(
      "../../generated-patterns/integration/patterns/counter-nested-handler-composition.pattern.ts",
      import.meta.url,
    );
    const programResolver = new FileSystemProgramResolver(
      fromFileUrl(modulePath),
    );
    const program = await runtime.harness.resolve(programResolver);
    program.mainExport = "counterWithNestedHandlerComposition";
    const patternFactory = await runtime.patternManager.compilePattern(program);

    const tx = runtime.edit();
    const resultCell = runtime.getCell<any>(
      space,
      { scenario: "native-draft-nested-handler" },
      patternFactory.resultSchema,
      tx,
    );
    const result = runtime.run(tx, patternFactory, {}, resultCell);
    const commitResult = await tx.commit();
    assert(commitResult.ok);

    const cancelSink = result.sink(() => {});
    await runtime.idle();

    const send = async (stream: string, payload: unknown) => {
      const targetCell = splitPath(stream).reduce<any>(
        (cell, segment) => cell.key(segment),
        result,
      );
      const sendResult = await runtime.editWithRetry((tx) =>
        targetCell.withTx(tx).send(payload)
      );
      assertEquals(sendResult.error, undefined);
      await runtime.idle();
    };

    await send("pipeline.stage", {
      amount: 2,
      multiplier: 4,
      tag: "stage-only",
    });
    await send("pipeline.commit", {});

    drafts.length = 0;
    await send("pipeline.process", {
      amount: 3,
      multiplier: 2,
      tag: "composed",
    });

    const draftContainsTransientStagePatch = drafts.some((draft) =>
      draft.operations.some((operation) =>
        operation.op === "patch" &&
        operation.patches.some((patch) =>
          patch.path.startsWith("/internal/__#0/")
        )
      )
    );
    assertEquals(draftContainsTransientStagePatch, false);

    const value = await result.key("value").pull();
    assertEquals(value as unknown as number, 14);
    assertEquals(runtimeErrors, []);

    cancelSink();
    await runtime.idle();
  } finally {
    await runtime.dispose();
    await storage.close();
  }
});

Deno.test("memory v2 transactions preserve the original previousValue across repeated primitive path writes", async () => {
  const { storage } = captureNativeDrafts();

  try {
    const seed = storage.edit();
    const seedWrite = seed.write({
      space,
      id: "of:memory-v2-primitive-rewrite",
      type,
      path: [],
    }, { value: { count: 0 } });
    assert(seedWrite.ok);
    const seedCommit = await seed.commit();
    assert(seedCommit.ok);

    const tx = storage.edit();
    const firstWrite = tx.write({
      space,
      id: "of:memory-v2-primitive-rewrite",
      type,
      path: ["value", "count"],
    }, 1);
    assert(firstWrite.ok);
    const secondWrite = tx.write({
      space,
      id: "of:memory-v2-primitive-rewrite",
      type,
      path: ["value", "count"],
    }, 2);
    assert(secondWrite.ok);

    assertEquals(Array.from(tx.getWriteDetails?.(space) ?? []), [{
      address: {
        space,
        id: "of:memory-v2-primitive-rewrite",
        type,
        path: ["value", "count"],
      },
      value: 2,
      previousValue: 0,
    }]);
  } finally {
    await storage.close();
  }
});

Deno.test("memory v2 writeBatch keeps fine-grained patches and original previous values for same-document writes", async () => {
  const { storage, drafts } = captureNativeDrafts();

  try {
    const seed = storage.edit();
    const seedWrite = seed.write({
      space,
      id: "of:memory-v2-batched-patch",
      type,
      path: [],
    }, { value: { profile: { name: "Ada", title: "Dr" } } });
    assert(seedWrite.ok);
    const seedCommit = await seed.commit();
    assert(seedCommit.ok);

    drafts.length = 0;

    const tx = storage.edit();
    const batchResult = tx.writeBatch?.([
      {
        address: {
          space,
          id: "of:memory-v2-batched-patch",
          type,
          path: ["value", "profile", "name"],
        },
        value: "Grace",
      },
      {
        address: {
          space,
          id: "of:memory-v2-batched-patch",
          type,
          path: ["value", "profile", "title"],
        },
        value: "Prof",
      },
      {
        address: {
          space,
          id: "of:memory-v2-batched-patch",
          type,
          path: ["value", "profile", "title"],
        },
        value: "Professor",
      },
    ]);
    assert(batchResult?.ok);
    assertEquals(Array.from(tx.getWriteDetails?.(space) ?? []), [
      {
        address: {
          space,
          id: "of:memory-v2-batched-patch",
          type,
          path: ["value", "profile", "name"],
        },
        value: "Grace",
        previousValue: "Ada",
      },
      {
        address: {
          space,
          id: "of:memory-v2-batched-patch",
          type,
          path: ["value", "profile", "title"],
        },
        value: "Professor",
        previousValue: "Dr",
      },
    ]);

    const commitResult = await tx.commit();
    assert(commitResult.ok);
    assertEquals(drafts, [{
      operations: [{
        op: "patch",
        id: "of:memory-v2-batched-patch",
        type,
        value: {
          value: { profile: { name: "Grace", title: "Professor" } },
        },
        patches: [
          {
            op: "replace",
            path: "/value/profile/name",
            value: "Grace",
          },
          {
            op: "replace",
            path: "/value/profile/title",
            value: "Professor",
          },
        ],
      }],
    }]);
  } finally {
    await storage.close();
  }
});

Deno.test("memory v2 transactions emit splice patch drafts for dense array length writes", async () => {
  const { storage, drafts } = captureNativeDrafts();

  try {
    const seed = storage.edit();
    const seedWrite = seed.write({
      space,
      id: "of:memory-v2-native-array-length",
      type,
      path: [],
    }, { value: { tags: ["one", "two"] } });
    assert(seedWrite.ok);
    const seedCommit = await seed.commit();
    assert(seedCommit.ok);

    drafts.length = 0;

    const tx = storage.edit();
    const writeResult = tx.write({
      space,
      id: "of:memory-v2-native-array-length",
      type,
      path: ["value", "tags", "length"],
    }, 1);
    assert(writeResult.ok);

    const commitResult = await tx.commit();
    assert(commitResult.ok);
    assertEquals(drafts, [{
      operations: [{
        op: "patch",
        id: "of:memory-v2-native-array-length",
        type,
        value: { value: { tags: ["one"] } },
        patches: [{
          op: "splice",
          path: "/value/tags",
          index: 1,
          remove: 1,
          add: [],
        }],
      }],
    }]);
  } finally {
    await storage.close();
  }
});

Deno.test("memory v2 writeBatch combines dense array element and length writes into index and splice patches", async () => {
  const { storage, drafts } = captureNativeDrafts();

  try {
    const seed = storage.edit();
    const seedWrite = seed.write({
      space,
      id: "of:memory-v2-batched-array-length",
      type,
      path: [],
    }, { value: { tags: ["one", "two"] } });
    assert(seedWrite.ok);
    const seedCommit = await seed.commit();
    assert(seedCommit.ok);

    drafts.length = 0;

    const tx = storage.edit();
    const batchResult = tx.writeBatch?.([
      {
        address: {
          space,
          id: "of:memory-v2-batched-array-length",
          type,
          path: ["value", "tags", "0"],
        },
        value: "zero",
      },
      {
        address: {
          space,
          id: "of:memory-v2-batched-array-length",
          type,
          path: ["value", "tags", "length"],
        },
        value: 1,
      },
    ]);
    assert(batchResult?.ok);

    const commitResult = await tx.commit();
    assert(commitResult.ok);
    assertEquals(drafts, [{
      operations: [{
        op: "patch",
        id: "of:memory-v2-batched-array-length",
        type,
        value: { value: { tags: ["zero"] } },
        patches: [{
          op: "replace",
          path: "/value/tags/0",
          value: "zero",
        }, {
          op: "splice",
          path: "/value/tags",
          index: 1,
          remove: 1,
          add: [],
        }],
      }],
    }]);
  } finally {
    await storage.close();
  }
});

Deno.test("memory v2 array splice drafts elide descendant patches for newly added tail entries", async () => {
  const { storage, drafts } = captureNativeDrafts();

  try {
    const seed = storage.edit();
    const seedWrite = seed.write({
      space,
      id: "of:memory-v2-array-splice-subsume-tail",
      type,
      path: [],
    }, {
      value: {
        internal: {
          visibleTemplates: [{
            id: "support-shift-schedule",
            tags: ["Support", "Schedule"],
          }],
        },
      },
    });
    assert(seedWrite.ok);
    const seedCommit = await seed.commit();
    assert(seedCommit.ok);

    drafts.length = 0;

    const tx = storage.edit();
    const batchResult = tx.writeBatch?.([
      {
        address: {
          space,
          id: "of:memory-v2-array-splice-subsume-tail",
          type,
          path: ["value", "internal", "visibleTemplates", "0"],
        },
        value: {
          id: "hero-email-kit",
          name: "Hero Email Kit",
          tags: ["Email", "Hero", "Campaign"],
        },
      },
      {
        address: {
          space,
          id: "of:memory-v2-array-splice-subsume-tail",
          type,
          path: ["value", "internal", "visibleTemplates", "1", "id"],
        },
        value: "support-shift-schedule",
      },
      {
        address: {
          space,
          id: "of:memory-v2-array-splice-subsume-tail",
          type,
          path: ["value", "internal", "visibleTemplates", "1", "name"],
        },
        value: "Support Shift Schedule",
      },
      {
        address: {
          space,
          id: "of:memory-v2-array-splice-subsume-tail",
          type,
          path: ["value", "internal", "visibleTemplates", "1", "tags"],
        },
        value: ["Support", "Schedule"],
      },
      {
        address: {
          space,
          id: "of:memory-v2-array-splice-subsume-tail",
          type,
          path: ["value", "internal", "visibleTemplates", "2", "id"],
        },
        value: "product-tour-deck",
      },
      {
        address: {
          space,
          id: "of:memory-v2-array-splice-subsume-tail",
          type,
          path: ["value", "internal", "visibleTemplates", "2", "name"],
        },
        value: "Product Tour Deck",
      },
      {
        address: {
          space,
          id: "of:memory-v2-array-splice-subsume-tail",
          type,
          path: ["value", "internal", "visibleTemplates", "2", "tags"],
        },
        value: ["Demo", "Slides"],
      },
    ]);
    assert(batchResult?.ok);

    const commitResult = await tx.commit();
    assert(commitResult.ok);
    assertEquals(drafts.length, 1);
    assertEquals(drafts[0].operations.length, 1);
    const [operation] = drafts[0].operations;
    assertEquals(operation.op, "patch");
    if (operation.op !== "patch") {
      throw new Error("expected patch operation");
    }
    assertEquals(operation.id, "of:memory-v2-array-splice-subsume-tail");
    assertEquals(operation.type, type);
    assertEquals(operation.patches.length, 2);
    assertEquals(operation.patches[0]?.op, "replace");
    assertEquals(
      operation.patches[0]?.path,
      "/value/internal/visibleTemplates/0",
    );
    const splicePatch = operation.patches[1];
    assertEquals(splicePatch?.op, "splice");
    if (splicePatch?.op !== "splice") {
      throw new Error("expected trailing splice patch");
    }
    assertEquals(splicePatch?.path, "/value/internal/visibleTemplates");
    assertEquals(splicePatch?.index, 1);
    assertEquals(splicePatch?.remove, 0);
    assertEquals(splicePatch?.add?.length, 2);
    assert(
      operation.patches.every((patch) =>
        !patch.path.startsWith("/value/internal/visibleTemplates/1/tags")
      ),
    );
  } finally {
    await storage.close();
  }
});

Deno.test("memory v2 transactions fall back to array replacement when filling sparse holes", async () => {
  const { storage, drafts } = captureNativeDrafts();

  try {
    const sparse: string[] = new Array(3);
    sparse[0] = "one";
    sparse[2] = "three";

    const seed = storage.edit();
    const seedWrite = seed.write({
      space,
      id: "of:memory-v2-native-array-sparse-fill",
      type,
      path: [],
    }, { value: { tags: sparse } });
    assert(seedWrite.ok);
    const seedCommit = await seed.commit();
    assert(seedCommit.ok);

    drafts.length = 0;

    const tx = storage.edit();
    const writeResult = tx.write({
      space,
      id: "of:memory-v2-native-array-sparse-fill",
      type,
      path: ["value", "tags", "1"],
    }, "two");
    assert(writeResult.ok);

    const commitResult = await tx.commit();
    assert(commitResult.ok);
    assertEquals(drafts, [{
      operations: [{
        op: "patch",
        id: "of:memory-v2-native-array-sparse-fill",
        type,
        value: { value: { tags: ["one", "two", "three"] } },
        patches: [{
          op: "replace",
          path: "/value/tags",
          value: ["one", "two", "three"],
        }],
      }],
    }]);
  } finally {
    await storage.close();
  }
});

Deno.test("memory v2 transactions collapse overlapping object-path writes into a parent patch draft", async () => {
  const { storage, drafts } = captureNativeDrafts();

  try {
    const seed = storage.edit();
    const seedWrite = seed.write({
      space,
      id: "of:memory-v2-native-overlap",
      type,
      path: [],
    }, { value: { profile: { name: "Ada", title: "Dr" } } });
    assert(seedWrite.ok);
    const seedCommit = await seed.commit();
    assert(seedCommit.ok);

    drafts.length = 0;

    const tx = storage.edit();
    const firstWrite = tx.write({
      space,
      id: "of:memory-v2-native-overlap",
      type,
      path: ["value", "profile"],
    }, { name: "Grace", title: "Prof" });
    assert(firstWrite.ok);
    const secondWrite = tx.write({
      space,
      id: "of:memory-v2-native-overlap",
      type,
      path: ["value", "profile", "title"],
    }, "Professor");
    assert(secondWrite.ok);

    const commitResult = await tx.commit();
    assert(commitResult.ok);
    assertEquals(drafts, [{
      operations: [{
        op: "patch",
        id: "of:memory-v2-native-overlap",
        type,
        value: { value: { profile: { name: "Grace", title: "Professor" } } },
        patches: [{
          op: "replace",
          path: "/value/profile",
          value: { name: "Grace", title: "Professor" },
        }],
      }],
    }]);
  } finally {
    await storage.close();
  }
});

Deno.test("memory v2 transactions keep materialized-parent writes as fine-grained patch drafts", async () => {
  const { storage, drafts } = captureNativeDrafts();

  try {
    const seed = storage.edit();
    const seedWrite = seed.write({
      space,
      id: "of:memory-v2-native-materialized-parent",
      type,
      path: [],
    }, { value: { count: 1 } });
    assert(seedWrite.ok);
    const seedCommit = await seed.commit();
    assert(seedCommit.ok);

    drafts.length = 0;

    const tx = storage.edit();
    const batchWrite = tx.writeBatch?.([
      {
        address: {
          space,
          id: "of:memory-v2-native-materialized-parent",
          type,
          path: ["value", "profile", "name"],
        },
        value: "Ada",
      },
      {
        address: {
          space,
          id: "of:memory-v2-native-materialized-parent",
          type,
          path: ["value", "profile", "age"],
        },
        value: 42,
      },
    ]);
    assert(batchWrite?.ok);

    const commitResult = await tx.commit();
    assert(commitResult.ok);
    assertEquals(drafts, [{
      operations: [{
        op: "patch",
        id: "of:memory-v2-native-materialized-parent",
        type,
        value: { value: { count: 1, profile: { name: "Ada", age: 42 } } },
        patches: [
          {
            op: "add",
            path: "/value/profile/name",
            value: "Ada",
          },
          {
            op: "add",
            path: "/value/profile/age",
            value: 42,
          },
        ],
      }],
    }]);
  } finally {
    await storage.close();
  }
});
