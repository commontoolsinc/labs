import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { type JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("bench operator");
const space = signer.did();

// Setup helper to create runtime and transaction
function setup() {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    blobbyServerUrl: import.meta.url,
    storageManager,
  });
  const tx = runtime.edit();
  return { runtime, storageManager, tx };
}

// Cleanup helper
async function cleanup(
  runtime: Runtime,
  storageManager: ReturnType<typeof StorageManager.emulate>,
  tx: IExtendedStorageTransaction,
) {
  await tx.commit();
  await runtime.dispose();
  await storageManager.close();
}

// Benchmark: Cell creation
Deno.bench("Cell creation - simple schemaless", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const cell = runtime.getCell<number>(space, "bench-cell", undefined, tx);
  cell.set(42);
  
  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell creation - with JSON schema", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number" },
    },
    required: ["name", "age"],
  } as const satisfies JSONSchema;
  
  const cell = runtime.getCell(space, "bench-cell-schema", schema, tx);
  cell.set({ name: "John", age: 30 });
  
  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell creation - immutable", async () => {
  const { runtime, storageManager, tx } = setup();
  
  runtime.getImmutableCell(
    space,
    { value: 42 },
    { type: "object", properties: { value: { type: "number" } } },
    tx,
  );
  
  await cleanup(runtime, storageManager, tx);
});

// Schema-based cell creation benchmarks
Deno.bench("Cell creation - simple with schema", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const schema = { type: "number" } as const satisfies JSONSchema;
  const cell = runtime.getCell(space, "bench-cell-schema", schema, tx);
  cell.set(42);
  
  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell creation - object with nested schema", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const schema = {
    type: "object",
    properties: {
      user: {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number", minimum: 0, maximum: 150 },
          email: { type: "string" },
        },
        required: ["name", "age"],
      },
      tags: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
      },
    },
    required: ["user", "tags"],
  } as const satisfies JSONSchema;
  
  const cell = runtime.getCell(space, "bench-nested-schema", schema, tx);
  cell.set({
    user: {
      name: "John Doe",
      age: 30,
      email: "john@example.com",
    },
    tags: ["developer", "typescript"],
  });
  
  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell creation - array with schema", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const schema = {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "number" },
        name: { type: "string" },
      },
      required: ["id", "name"],
    },
  } as const satisfies JSONSchema;
  
  const cell = runtime.getCell(space, "bench-array-schema", schema, tx);
  cell.set([
    { id: 1, name: "Item 1" },
    { id: 2, name: "Item 2" },
  ]);
  
  await cleanup(runtime, storageManager, tx);
});

// Benchmark: Cell get operations
Deno.bench("Cell get - simple value schemaless", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const cell = runtime.getCell<number>(space, "bench-get", undefined, tx);
  cell.set(42);
  
  // Measure get operation
  for (let i = 0; i < 1000; i++) {
    cell.get();
  }
  
  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell get - complex object schemaless", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const cell = runtime.getCell<{
    name: string;
    age: number;
    tags: string[];
    nested: { value: number };
  }>(space, "bench-get-complex", undefined, tx);
  
  cell.set({
    name: "test",
    age: 42,
    tags: ["a", "b", "c"],
    nested: { value: 123 },
  });
  
  // Measure get operation
  for (let i = 0; i < 1000; i++) {
    cell.get();
  }
  
  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell getRaw - complex object schemaless", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const cell = runtime.getCell<{
    name: string;
    age: number;
    tags: string[];
    nested: { value: number };
  }>(space, "bench-getRaw", undefined, tx);
  
  cell.set({
    name: "test",
    age: 42,
    tags: ["a", "b", "c"],
    nested: { value: 123 },
  });
  
  // Measure getRaw operation
  for (let i = 0; i < 1000; i++) {
    cell.getRaw();
  }
  
  await cleanup(runtime, storageManager, tx);
});

// Schema-based get operations
Deno.bench("Cell get - simple value with schema", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const schema = { type: "number", minimum: 0 } as const satisfies JSONSchema;
  const cell = runtime.getCell(space, "bench-get-schema", schema, tx);
  cell.set(42);
  
  // Measure get operation
  for (let i = 0; i < 1000; i++) {
    cell.get();
  }
  
  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell get - complex object with schema", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number" },
      tags: {
        type: "array",
        items: { type: "string" },
      },
      nested: {
        type: "object",
        properties: {
          value: { type: "number" },
        },
        required: ["value"],
      },
    },
    required: ["name", "age", "tags", "nested"],
  } as const satisfies JSONSchema;
  
  const cell = runtime.getCell(space, "bench-get-complex-schema", schema, tx);
  
  cell.set({
    name: "test",
    age: 42,
    tags: ["a", "b", "c"],
    nested: { value: 123 },
  });
  
  // Measure get operation
  for (let i = 0; i < 1000; i++) {
    cell.get();
  }
  
  await cleanup(runtime, storageManager, tx);
});

// Benchmark: Cell set operations
Deno.bench("Cell set - simple value schemaless", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const cell = runtime.getCell<number>(space, "bench-set", undefined, tx);
  
  // Measure set operation
  for (let i = 0; i < 100; i++) {
    cell.set(i);
  }
  
  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell send - simple value schemaless", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const cell = runtime.getCell<number>(space, "bench-send", undefined, tx);
  cell.set(0);
  
  // Measure send operation
  for (let i = 0; i < 100; i++) {
    cell.send(i);
  }
  
  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell update - partial object update schemaless", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const cell = runtime.getCell<{
    name: string;
    age: number;
    tags: string[];
  }>(space, "bench-update", undefined, tx);
  
  cell.set({ name: "test", age: 42, tags: ["a", "b"] });
  
  // Measure update operation
  for (let i = 0; i < 100; i++) {
    cell.update({ age: i });
  }
  
  await cleanup(runtime, storageManager, tx);
});

// Schema-based set operations
Deno.bench("Cell set - simple value with schema", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const schema = { type: "number", minimum: 0, maximum: 100 } as const satisfies JSONSchema;
  const cell = runtime.getCell(space, "bench-set-schema", schema, tx);
  
  // Measure set operation
  for (let i = 0; i < 100; i++) {
    cell.set(i);
  }
  
  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell update - partial object update with schema", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number", minimum: 0 },
      tags: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["name", "age", "tags"],
  } as const satisfies JSONSchema;
  
  const cell = runtime.getCell(space, "bench-update-schema", schema, tx);
  
  cell.set({ name: "test", age: 42, tags: ["a", "b"] });
  
  // Measure update operation
  for (let i = 0; i < 100; i++) {
    cell.update({ age: i });
  }
  
  await cleanup(runtime, storageManager, tx);
});

// Benchmark: Nested cell operations
Deno.bench("Cell key - nested access schemaless", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const cell = runtime.getCell<{
    a: { b: { c: { d: number } } };
  }>(space, "bench-key", undefined, tx);
  
  cell.set({ a: { b: { c: { d: 42 } } } });
  
  // Measure nested key access
  for (let i = 0; i < 1000; i++) {
    cell.key("a").key("b").key("c").key("d").get();
  }
  
  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell key - array access schemaless", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const cell = runtime.getCell<{
    items: Array<{ name: string; value: number }>;
  }>(space, "bench-key-array", undefined, tx);
  
  cell.set({
    items: Array.from({ length: 100 }, (_, i) => ({
      name: `item${i}`,
      value: i,
    })),
  });
  
  // Measure array key access
  for (let i = 0; i < 100; i++) {
    cell.key("items").key(i).key("value").get();
  }
  
  await cleanup(runtime, storageManager, tx);
});

// Schema-based nested operations
Deno.bench("Cell key - nested access with schema", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const schema = {
    type: "object",
    properties: {
      a: {
        type: "object",
        properties: {
          b: {
            type: "object",
            properties: {
              c: {
                type: "object",
                properties: {
                  d: { type: "number" },
                },
                required: ["d"],
              },
            },
            required: ["c"],
          },
        },
        required: ["b"],
      },
    },
    required: ["a"],
  } as const satisfies JSONSchema;
  
  const cell = runtime.getCell(space, "bench-key-schema", schema, tx);
  
  cell.set({ a: { b: { c: { d: 42 } } } });
  
  // Measure nested key access
  for (let i = 0; i < 1000; i++) {
    cell.key("a").key("b").key("c").key("d").get();
  }
  
  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell key - array access with schema", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const schema = {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            value: { type: "number" },
          },
          required: ["name", "value"],
        },
      },
    },
    required: ["items"],
  } as const satisfies JSONSchema;
  
  const cell = runtime.getCell(space, "bench-key-array-schema", schema, tx);
  
  cell.set({
    items: Array.from({ length: 100 }, (_, i) => ({
      name: `item${i}`,
      value: i,
    })),
  });
  
  // Measure array key access
  for (let i = 0; i < 100; i++) {
    cell.key("items").key(i).key("value").get();
  }
  
  await cleanup(runtime, storageManager, tx);
});

// Benchmark: Cell derivation
Deno.bench("Cell asSchema - schema transformation", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const cell = runtime.getCell<{
    id: number;
    metadata: { createdAt: string; type: string };
  }>(space, "bench-asSchema", undefined, tx);
  
  cell.set({
    id: 1,
    metadata: { createdAt: "2025-01-06", type: "user" },
  });
  
  const schema = {
    type: "object",
    properties: {
      id: { type: "number" },
      metadata: { type: "object", asCell: true },
    },
    required: ["id", "metadata"],
  } as const satisfies JSONSchema;
  
  // Measure asSchema transformation
  for (let i = 0; i < 1000; i++) {
    const schemaCell = cell.asSchema(schema);
    schemaCell.get();
  }
  
  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell withTx - transaction switching", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const cell = runtime.getCell<number>(space, "bench-withTx", undefined, tx);
  cell.set(42);
  
  const tx2 = runtime.edit();
  
  // Measure withTx operation
  for (let i = 0; i < 1000; i++) {
    const newCell = cell.withTx(i % 2 === 0 ? tx : tx2);
    newCell.get();
  }
  
  await tx2.commit();
  await cleanup(runtime, storageManager, tx);
});

// Benchmark: Query result proxy operations
Deno.bench("Cell getAsQueryResult - proxy creation schemaless", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const cell = runtime.getCell<{
    name: string;
    age: number;
    nested: { value: number };
  }>(space, "bench-proxy", undefined, tx);
  
  cell.set({
    name: "test",
    age: 42,
    nested: { value: 123 },
  });
  
  // Measure proxy creation and access
  for (let i = 0; i < 1000; i++) {
    const proxy = cell.getAsQueryResult();
    proxy.name;
    proxy.nested.value;
  }
  
  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell proxy - property writes schemaless", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const cell = runtime.getCell<{
    x: number;
    y: number;
  }>(space, "bench-proxy-write", undefined, tx);
  
  cell.set({ x: 1, y: 2 });
  const proxy = cell.getAsQueryResult();
  
  // Measure proxy writes
  for (let i = 0; i < 100; i++) {
    proxy.x = i;
    proxy.y = i * 2;
  }
  
  await cleanup(runtime, storageManager, tx);
});

// Schema-based proxy operations
Deno.bench("Cell getAsQueryResult - proxy creation with schema", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number" },
      nested: {
        type: "object",
        properties: {
          value: { type: "number" },
        },
        required: ["value"],
      },
    },
    required: ["name", "age", "nested"],
  } as const satisfies JSONSchema;
  
  const cell = runtime.getCell(space, "bench-proxy-schema", schema, tx);
  
  cell.set({
    name: "test",
    age: 42,
    nested: { value: 123 },
  });
  
  // Measure proxy creation and access
  for (let i = 0; i < 1000; i++) {
    const proxy = cell.getAsQueryResult();
    proxy.name;
    proxy.nested.value;
  }
  
  await cleanup(runtime, storageManager, tx);
});

// Benchmark: Array operations
Deno.bench("Cell push - array append schemaless", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const cell = runtime.getCell<{ items: number[] }>(
    space,
    "bench-push",
    undefined,
    tx,
  );
  cell.set({ items: [] });
  const arrayCell = cell.key("items");
  
  // Measure push operations
  for (let i = 0; i < 100; i++) {
    arrayCell.push(i);
  }
  
  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell array - map operation schemaless", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const cell = runtime.getCell<{ items: number[] }>(
    space,
    "bench-array-map",
    undefined,
    tx,
  );
  cell.set({ items: Array.from({ length: 100 }, (_, i) => i) });
  
  const proxy = cell.getAsQueryResult();
  
  // Measure array map operation
  for (let i = 0; i < 10; i++) {
    proxy.items.map((x: number) => x * 2);
  }
  
  await cleanup(runtime, storageManager, tx);
});

// Schema-based array operations
Deno.bench("Cell push - array append with schema", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const schema = {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: { type: "number", minimum: 0 },
      },
    },
    required: ["items"],
  } as const satisfies JSONSchema;
  
  const cell = runtime.getCell(space, "bench-push-schema", schema, tx);
  cell.set({ items: [] });
  const arrayCell = cell.key("items");
  
  // Measure push operations
  for (let i = 0; i < 100; i++) {
    arrayCell.push(i);
  }
  
  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell array - map operation with schema", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const schema = {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: { type: "number" },
      },
    },
    required: ["items"],
  } as const satisfies JSONSchema;
  
  const cell = runtime.getCell(space, "bench-array-map-schema", schema, tx);
  cell.set({ items: Array.from({ length: 100 }, (_, i) => i) });
  
  const proxy = cell.getAsQueryResult();
  
  // Measure array map operation
  for (let i = 0; i < 10; i++) {
    proxy.items.map((x: number) => x * 2);
  }
  
  await cleanup(runtime, storageManager, tx);
});

// Benchmark: Link operations
Deno.bench("Cell getAsLink - link generation schemaless", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const cell = runtime.getCell<{ value: number }>(
    space,
    "bench-link",
    undefined,
    tx,
  );
  cell.set({ value: 42 });
  
  // Measure link generation
  for (let i = 0; i < 1000; i++) {
    cell.getAsLink();
  }
  
  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell getAsLink - with options", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const cell1 = runtime.getCell<{ value: number }>(
    space,
    "bench-link-1",
    undefined,
    tx,
  );
  cell1.set({ value: 42 });
  
  const cell2 = runtime.getCell<{ other: string }>(
    space,
    "bench-link-2",
    undefined,
    tx,
  );
  cell2.set({ other: "test" });
  
  // Measure link generation with options
  for (let i = 0; i < 1000; i++) {
    cell1.getAsLink({ base: cell2, includeSchema: true });
  }
  
  await cleanup(runtime, storageManager, tx);
});

// Benchmark: Subscription operations
Deno.bench("Cell sink - subscription setup", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const cell = runtime.getCell<number>(space, "bench-sink", undefined, tx);
  cell.set(0);
  
  const cancels: Array<() => void> = [];
  
  // Measure sink subscription setup
  for (let i = 0; i < 100; i++) {
    const cancel = cell.sink(() => {});
    cancels.push(cancel);
  }
  
  // Cleanup subscriptions
  cancels.forEach((cancel) => cancel());
  
  await cleanup(runtime, storageManager, tx);
});

// Benchmark: Complex nested operations
Deno.bench("Cell complex - schema with asCell references", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const schema = {
    type: "object",
    properties: {
      id: { type: "number" },
      metadata: {
        type: "object",
        asCell: true,
      },
      tags: {
        type: "array",
        items: { type: "string" },
      },
      settings: {
        type: "object",
        properties: {
          theme: { type: "string" },
          notifications: { type: "boolean" },
        },
        asCell: true,
      },
    },
    required: ["id", "metadata", "tags", "settings"],
  } as const satisfies JSONSchema;
  
  const cell = runtime.getCell(space, "bench-asCell-schema", schema, tx);
  
  cell.set({
    id: 1,
    metadata: {
      createdAt: "2025-01-06",
      type: "user",
    },
    tags: ["developer", "typescript"],
    settings: {
      theme: "dark",
      notifications: true,
    },
  });
  
  // Measure access with asCell references
  for (let i = 0; i < 1000; i++) {
    const value = cell.get();
    value.id;
    value.metadata.get();
    value.tags;
    value.settings.get();
  }
  
  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell complex - nested cell references", async () => {
  const { runtime, storageManager, tx } = setup();
  
  // Create inner cells
  const inner1 = runtime.getCell<{ value: number }>(
    space,
    "bench-inner-1",
    undefined,
    tx,
  );
  inner1.set({ value: 1 });
  
  const inner2 = runtime.getCell<{ value: number }>(
    space,
    "bench-inner-2",
    undefined,
    tx,
  );
  inner2.set({ value: 2 });
  
  // Create outer cell with references
  const outer = runtime.getCell<{
    ref1: any;
    ref2: any;
  }>(space, "bench-outer", undefined, tx);
  
  outer.set({
    ref1: inner1,
    ref2: inner2,
  });
  
  // Measure nested reference access
  for (let i = 0; i < 1000; i++) {
    const proxy = outer.getAsQueryResult();
    proxy.ref1;
    proxy.ref2;
  }
  
  await cleanup(runtime, storageManager, tx);
});

// Benchmark: Schema validation
Deno.bench("Cell schema - complex validation", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const complexSchema = {
    type: "object",
    properties: {
      id: { type: "string" },
      user: {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number", minimum: 0, maximum: 150 },
          email: { type: "string", format: "email" },
        },
        required: ["name", "age"],
      },
      tags: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 10,
      },
      metadata: {
        type: "object",
        additionalProperties: { type: "string" },
      },
    },
    required: ["id", "user", "tags"],
  } as const satisfies JSONSchema;
  
  const cell = runtime.getCell(
    space,
    "bench-schema-complex",
    complexSchema,
    tx,
  );
  
  // Measure complex object set with schema validation
  for (let i = 0; i < 100; i++) {
    cell.set({
      id: `user-${i}`,
      user: {
        name: `User ${i}`,
        age: 25 + (i % 50),
        email: `user${i}@example.com`,
      },
      tags: ["tag1", "tag2", "tag3"],
      metadata: {
        created: "2025-01-01",
        updated: "2025-01-22",
      },
    });
  }
  
  await cleanup(runtime, storageManager, tx);
});

// Benchmark: Large data structures
Deno.bench("Cell large - array with 1000 items", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const cell = runtime.getCell<{ items: Array<{ id: number; data: string }> }>(
    space,
    "bench-large-array",
    undefined,
    tx,
  );
  
  // Create large array
  const items = Array.from({ length: 1000 }, (_, i) => ({
    id: i,
    data: `item-${i}`,
  }));
  
  // Measure set operation with large data
  cell.set({ items });
  
  // Measure get operation with large data
  for (let i = 0; i < 10; i++) {
    cell.get();
  }
  
  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell large - deeply nested object", async () => {
  const { runtime, storageManager, tx } = setup();
  
  // Create deeply nested structure
  const createNested = (depth: number): any => {
    if (depth === 0) return { value: 42 };
    return { nested: createNested(depth - 1) };
  };
  
  const cell = runtime.getCell<any>(
    space,
    "bench-deep-nested",
    undefined,
    tx,
  );
  
  const deepData = createNested(10); // 10 levels deep
  cell.set(deepData);
  
  // Measure deep navigation
  for (let i = 0; i < 100; i++) {
    let current = cell;
    for (let j = 0; j < 10; j++) {
      current = current.key("nested");
    }
    current.key("value").get();
  }
  
  await cleanup(runtime, storageManager, tx);
});

// Benchmark: Concurrent operations
Deno.bench("Cell concurrent - multiple cells", async () => {
  const { runtime, storageManager, tx } = setup();
  
  // Create multiple cells
  const cells = Array.from({ length: 10 }, (_, i) =>
    runtime.getCell<number>(space, `bench-concurrent-${i}`, undefined, tx)
  );
  
  // Initialize cells
  cells.forEach((cell, i) => cell.set(i));
  
  // Measure concurrent access
  for (let i = 0; i < 100; i++) {
    cells.forEach((cell) => cell.get());
  }
  
  await cleanup(runtime, storageManager, tx);
});

// Benchmark: Cell equals comparison
Deno.bench("Cell equals - comparison operations", async () => {
  const { runtime, storageManager, tx } = setup();
  
  const cell1 = runtime.getCell<number>(space, "bench-equals-1", undefined, tx);
  const cell2 = runtime.getCell<number>(space, "bench-equals-2", undefined, tx);
  const cell1Same = runtime.getCell<number>(
    space,
    "bench-equals-1",
    undefined,
    tx,
  );
  
  cell1.set(42);
  cell2.set(42);
  
  // Measure equals operations
  for (let i = 0; i < 1000; i++) {
    cell1.equals(cell1Same); // Should be true
    cell1.equals(cell2); // Should be false
  }
  
  await cleanup(runtime, storageManager, tx);
});