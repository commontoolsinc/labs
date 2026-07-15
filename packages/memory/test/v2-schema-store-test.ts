import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { Database } from "@db/sqlite";
import { toFileUrl } from "@std/path";
import type { JSONSchema } from "@commonfabric/api";
import { jsonFromValue } from "@commonfabric/data-model/codec-json";
import { FabricLink } from "@commonfabric/data-model/fabric-instances";
import {
  FabricBytes,
  FabricEpochNsec,
  FabricHash,
} from "@commonfabric/data-model/fabric-primitives";
import {
  openSchemaStore,
  SchemaStoreCorruptionError,
  SchemaStoreQuotaError,
} from "../v2/schema-store.ts";

const withStore = async (
  run: (url: URL) => Promise<void>,
): Promise<void> => {
  const directory = await Deno.makeTempDir({ prefix: "schema-store-" });
  try {
    await run(toFileUrl(`${directory}/schemas.sqlite`));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
};

const encodedByteLength = (schema: JSONSchema): number =>
  new TextEncoder().encode(jsonFromValue(schema)).byteLength;

const schemaWithRuntimeDefault = (
  defaultValue: unknown,
): JSONSchema => {
  const schema: JSONSchema = { type: "object" };
  Object.defineProperty(schema, "default", {
    value: defaultValue,
    enumerable: true,
  });
  return schema;
};

Deno.test("schema store canonicalizes structurally equal schemas", async () => {
  await withStore(async (url) => {
    const store = await openSchemaStore({ url });
    try {
      const first: JSONSchema = {
        required: ["title"],
        properties: { title: { type: "string" }, count: { type: "number" } },
        type: "object",
      };
      const second: JSONSchema = {
        type: "object",
        properties: { count: { type: "number" }, title: { type: "string" } },
        required: ["title"],
      };

      const stored = store.put(first);
      const duplicate = store.put(second);

      assertEquals(duplicate.hash, stored.hash);
      assertStrictEquals(duplicate.schema, stored.schema);
      assert(Object.isFrozen(stored.schema));
      assertEquals(store.get(stored.hash), stored);
    } finally {
      store.close();
    }
  });
});

Deno.test("schema store persists entries and generation across close and reopen", async () => {
  await withStore(async (url) => {
    const first = await openSchemaStore({ url });
    const stored = first.put({ type: "string" });
    const generation = first.generation;
    first.close();

    const reopened = await openSchemaStore({ url });
    try {
      assertEquals(reopened.generation, generation);
      assertEquals(reopened.get(stored.hash), stored);
      assertEquals(reopened.get("fid1:not-present"), undefined);
      assertEquals(reopened.has(stored.hash), true);
      assertEquals(reopened.has("fid1:not-present"), false);
    } finally {
      reopened.close();
    }
  });
});

Deno.test("schema store preserves Fabric runtime defaults across close and reopen", async () => {
  await withStore(async (url) => {
    const epoch = new FabricEpochNsec(1_234_567_890n);
    const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
    const hash = new FabricHash(new Uint8Array([4, 5, 6]), "test");
    const link = new FabricLink({ id: "of:runtime-default", path: [] });
    const first = await openSchemaStore({ url });
    const stored = [epoch, bytes, hash, link].map((defaultValue) =>
      first.put(schemaWithRuntimeDefault(defaultValue))
    );
    first.close();

    const reopened = await openSchemaStore({ url });
    try {
      const defaults = stored.map((entry) => {
        const schema = reopened.get(entry.hash)?.schema;
        return schema !== undefined
          ? Object.getOwnPropertyDescriptor(schema, "default")?.value
          : undefined;
      });
      const [restoredEpoch, restoredBytes, restoredHash, restoredLink] =
        defaults;

      assert(restoredEpoch instanceof FabricEpochNsec);
      assertEquals(restoredEpoch.value, epoch.value);
      assert(restoredBytes instanceof FabricBytes);
      assertEquals(restoredBytes.slice(), bytes.slice());
      assert(restoredHash instanceof FabricHash);
      assertEquals(restoredHash.toString(), hash.toString());
      assert(restoredLink instanceof FabricLink);
      assertEquals(restoredLink.payload, link.payload);
    } finally {
      reopened.close();
    }
  });
});

Deno.test("schema store fails closed for hash and byte corruption", async () => {
  await withStore(async (url) => {
    const store = await openSchemaStore({ url });
    const stored = store.put({ type: "string" });
    store.close();

    const database = await new Database(url.pathname, { create: true });
    try {
      database.prepare(
        "UPDATE schema_store_entries SET canonical_json = ?, byte_length = ? WHERE hash = ?",
      ).run("fvj1:true", 9, stored.hash);
    } finally {
      database.close();
    }

    const reopened = await openSchemaStore({ url });
    try {
      assertThrows(
        () => reopened.get(stored.hash),
        SchemaStoreCorruptionError,
        "does not match its tagged content hash",
      );
      assertThrows(
        () => reopened.has(stored.hash),
        SchemaStoreCorruptionError,
      );
    } finally {
      reopened.close();
    }
  });
});

Deno.test("schema store fails closed for malformed Fabric JSON", async () => {
  await withStore(async (url) => {
    const store = await openSchemaStore({ url });
    const stored = store.put({ type: "string" });
    store.close();

    const malformed = "fvj1:{";
    const database = await new Database(url.pathname, { create: true });
    try {
      database.prepare(
        "UPDATE schema_store_entries SET canonical_json = ?, byte_length = ? WHERE hash = ?",
      ).run(
        malformed,
        new TextEncoder().encode(malformed).byteLength,
        stored.hash,
      );
    } finally {
      database.close();
    }

    const reopened = await openSchemaStore({ url });
    try {
      assertThrows(
        () => reopened.get(stored.hash),
        SchemaStoreCorruptionError,
        "invalid Fabric JSON",
      );
    } finally {
      reopened.close();
    }
  });
});

Deno.test("schema store quotas permit duplicates without consuming capacity", async () => {
  await withStore(async (url) => {
    const store = await openSchemaStore({ url, maxEntries: 1 });
    try {
      const stored = store.put({ type: "string" });
      assertEquals(store.put({ type: "string" }), stored);
      assertThrows(
        () => store.put({ type: "number" }),
        SchemaStoreQuotaError,
        "maxEntries",
      );
    } finally {
      store.close();
    }
  });

  await withStore(async (url) => {
    const stringSchema: JSONSchema = { type: "string" };
    const store = await openSchemaStore({
      url,
      maxSchemaBytes: encodedByteLength(stringSchema) - 1,
    });
    try {
      assertThrows(
        () => store.put(stringSchema),
        SchemaStoreQuotaError,
        "maxSchemaBytes",
      );
    } finally {
      store.close();
    }
  });

  await withStore(async (url) => {
    const stringSchema: JSONSchema = { type: "string" };
    const numberSchema: JSONSchema = { type: "number" };
    const store = await openSchemaStore({
      url,
      maxTotalBytes: encodedByteLength(stringSchema) +
        encodedByteLength(numberSchema) - 1,
    });
    try {
      store.put(stringSchema);
      assertThrows(
        () => store.put(numberSchema),
        SchemaStoreQuotaError,
        "maxTotalBytes",
      );
    } finally {
      store.close();
    }
  });
});

Deno.test("schema store inserts schema batches atomically", async () => {
  await withStore(async (url) => {
    const store = await openSchemaStore({ url, maxEntries: 1 });
    try {
      assertThrows(
        () => store.putAll([{ type: "string" }, { type: "number" }]),
        SchemaStoreQuotaError,
        "maxEntries",
      );
      assertEquals(store.putAll([]), []);
      assertEquals(store.put({ type: "boolean" }).schema, { type: "boolean" });
    } finally {
      store.close();
    }
  });
});

Deno.test("schema stores are isolated by durable URL", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "schema-store-isolation-",
  });
  try {
    const left = await openSchemaStore({
      url: toFileUrl(`${directory}/left.sqlite`),
    });
    const right = await openSchemaStore({
      url: toFileUrl(`${directory}/right.sqlite`),
    });
    try {
      const stored = left.put({ type: "boolean" });
      assertEquals(right.get(stored.hash), undefined);
      assert(left.generation !== right.generation);
    } finally {
      left.close();
      right.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
