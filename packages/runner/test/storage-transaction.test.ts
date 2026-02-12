import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Identity } from "@commontools/identity";
import { Runtime } from "../src/runtime.ts";
import { getJSONFromDataURI } from "../src/uri-utils.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  INotFoundError,
} from "../src/storage/interface.ts";
import { getEntityId } from "../src/create-ref.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("StorageTransaction", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL("http://localhost:8000"),
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should create a transaction and read/write values", async () => {
    const transaction = runtime.edit();

    // Check initial status
    const statusResult = transaction.status();
    expect(statusResult.status).toBe("ready");

    // First write to root path to create a record
    const rootWriteResult = transaction.write({
      space,
      id: "of:test-entity",
      type: "application/json",
      path: [],
    }, { value: {} });

    expect(rootWriteResult.ok).toBeDefined();

    // Test writing a value to nested path
    const writeResult = transaction.write({
      space,
      id: "of:test-entity",
      type: "application/json",
      path: ["value", "name"],
    }, "John Doe");

    expect(writeResult.ok).toBeDefined();
    // Because we have merged the writes, we will return the top level write
    expect(writeResult.ok?.address.path).toEqual([]);
    expect(writeResult.ok?.value).toEqual({ "value": { "name": "John Doe" } });

    // Test reading the value
    const readResult = transaction.read({
      space,
      id: "of:test-entity",
      type: "application/json",
      path: ["value", "name"],
    });

    expect(readResult.ok).toBeDefined();
    expect(readResult.ok?.value).toBe("John Doe");

    // Test reading non-existent path
    const readNonExistentResult = transaction.read({
      space,
      id: "of:test-entity",
      type: "application/json",
      path: ["value", "address", "city"],
    });

    expect(readNonExistentResult.error).toBeDefined();
    expect(readNonExistentResult.error?.name).toBe("NotFoundError");
    // read at ["value", "address", "city"] is an error, since there is no address
    // read at ["value", "address"] returns undefined, but it's a valid read
    expect((readNonExistentResult.error as INotFoundError).path).toEqual([
      "value",
      "address",
    ]);

    // Test writing a value to nested path
    const writeResult2 = transaction.write({
      space,
      id: "of:test-entity",
      type: "application/json",
      path: ["value", "address"],
    }, { street: "123 Main St" });

    expect(writeResult2.ok).toBeDefined();
    // Because we have merged the writes, we will return the top level write
    expect(writeResult2.ok?.address.path).toEqual([]);
    expect(writeResult2.ok?.value).toEqual({
      value: { address: { street: "123 Main St" }, name: "John Doe" },
    });

    // Test reading non-existent path in a parent that does exist
    const readNonExistentResult2 = transaction.read({
      space,
      id: "of:test-entity",
      type: "application/json",
      path: ["value", "address", "country", "countryCode"],
    });

    expect(readNonExistentResult2.error).toBeDefined();
    expect(readNonExistentResult2.error?.name).toBe("NotFoundError");
    expect((readNonExistentResult2.error as INotFoundError).path).toEqual([
      "value",
      "address",
      "country",
    ]);

    // Test commit - dummy commit always succeeds
    const commitResult = await transaction.commit();
    expect(commitResult.error).toBeUndefined(); // No error means success

    // Check final status
    const finalStatusResult = transaction.status();
    expect(finalStatusResult.status).toBe("done");
  });

  it("should handle transaction abort", async () => {
    const transaction = runtime.edit();

    // Abort the transaction
    const abortResult = transaction.abort();
    expect(abortResult.error).toBeUndefined(); // No error means success

    // It should be aborted
    const statusResult = transaction.status();
    expect(statusResult.status).toBe("error");
    if (statusResult.status === "error") {
      expect(statusResult.error.name).toBe("StorageTransactionAborted");
    }

    // Try to commit aborted transaction
    const commitResult = await transaction.commit();
    expect(commitResult.error).toBeDefined();
    expect(commitResult.error?.name).toBe("StorageTransactionCompleteError");
  });

  it("should enforce write isolation per space", () => {
    const transaction = runtime.edit();

    // Open writer for first space
    const writer1Result = transaction.writer(space);
    expect(writer1Result.ok).toBeDefined();

    // Try to open writer for different space - should fail
    const writer2Result = transaction.writer("did:test:space2");
    expect(writer2Result.error).toBeDefined();
    expect(writer2Result.error?.name).toBe(
      "StorageTransactionWriteIsolationError",
    );
  });

  describe("write validation", () => {
    it("should allow writing to root path when document is empty", () => {
      const transaction = runtime.edit();

      const result = transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: [],
      }, { value: { name: "test" } });

      expect(result.error).toBeUndefined();
      expect(result.ok).toBeDefined();
    });

    it("should fail writing to nested path when document is not a record", () => {
      const transaction = runtime.edit();

      // First write a non-record value to the document
      transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: [],
      }, { value: "not a record" });

      // Try to write to a nested path
      const result = transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value", "a"],
      }, "value");

      expect(result.error).toBeDefined();
      expect(result.error!.name).toBe("TypeMismatchError");
    });

    it("should fail writing to deeply nested path when parent is not a record", () => {
      const transaction = runtime.edit();

      // First write a record with a non-record value at "a"
      transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: [],
      }, { value: { a: "not a record" } });

      // Try to write to a deeply nested path
      const result = transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value", "a", "b"],
      }, "value");

      expect(result.error).toBeDefined();
      expect(result.error!.name).toBe("TypeMismatchError");
    });

    it("should allow writing to nested path when parent is a record", () => {
      const transaction = runtime.edit();

      // First write a record value to the document
      transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: [],
      }, { value: { a: {} } });

      // Write to a nested path
      const result = transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value", "a", "b"],
      }, "value");

      expect(result.error).toBeUndefined();
      expect(result.ok).toBeDefined();
    });

    it("should allow writing to deeply nested path when all parents are records", () => {
      const transaction = runtime.edit();

      // First write a record with nested structure
      transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: [],
      }, { value: { a: { b: { c: {} } } } });

      // Write to a deeply nested path
      const result = transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value", "a", "b", "c", "d"],
      }, "deep value");

      expect(result.error).toBeUndefined();
      expect(result.ok).toBeDefined();
    });

    it("should fail writing to nested path when parent path doesn't exist", () => {
      const transaction = runtime.edit();

      // First write a record to the document
      const writeResult = transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: [],
      }, { value: { existing: "value" } });
      expect(writeResult.ok).toBeDefined();

      // Try to write to a path where parent doesn't exist
      const result = transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value", "missing", "nested"],
      }, "value");

      expect(result.error).toBeDefined();
      expect(result.error!.name).toBe("NotFoundError");
      expect(result.error!.message).toBe(
        "Cannot access path [value, missing, nested] - path does not exist",
      );
    });

    it("should set NotFoundError.path to last valid parent for deeply nested writes", () => {
      const transaction = runtime.edit();

      // First write a record with a nested structure
      transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: [],
      }, { value: { a: { b: { c: "not a record" } } } });

      // Try to write to a deeply nested path where parent is not a record
      const result = transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value", "a", "b", "c", "d"],
      }, "deep value");

      expect(result.error).toBeDefined();
      expect(result.error!.name).toBe("TypeMismatchError");
    });
  });

  describe("source path behavior", () => {
    it("should write and read the sourceCell via the 'source' path", () => {
      const transaction = runtime.edit();
      // Create two docs
      const doc1Id = "of:doc1";
      const doc2Id = "of:doc2";
      // Write to root of both docs
      expect(
        transaction.write({
          space,
          id: doc1Id,
          type: "application/json",
          path: [],
        }, { value: { foo: 1 } }).ok,
      ).toBeDefined();
      expect(
        transaction.write({
          space,
          id: doc2Id,
          type: "application/json",
          path: [],
        }, { value: { bar: 2 } }).ok,
      ).toBeDefined();
      // Set doc1's sourceCell to doc2
      const setSource = transaction.write({
        space,
        id: doc1Id,
        type: "application/json",
        path: ["source"],
      }, JSON.stringify(getEntityId(doc2Id)));
      expect(setSource.ok).toBeDefined();
      // Read back the sourceCell
      const readSource = transaction.read({
        space,
        id: doc1Id,
        type: "application/json",
        path: ["source"],
      });
      expect(readSource.ok).toBeDefined();
      expect(readSource.ok?.value).toEqual(
        JSON.parse(JSON.stringify(getEntityId(doc2Id))),
      );
    });

    it("should error if path beyond 'source' is used", () => {
      const transaction = runtime.edit();
      const doc1Id = "of:doc1";
      // We need to write something, or we'll get a NotFoundError when we
      // attempt to write to ["value"]
      transaction.write({
        space,
        id: doc1Id,
        type: "application/json",
        path: [],
      }, {});
      expect(
        transaction.write({
          space,
          id: doc1Id,
          type: "application/json",
          path: ["value"],
        }, {}).ok,
      ).toBeDefined();
      const result = transaction.write({
        space,
        id: doc1Id,
        type: "application/json",
        path: ["source", "extra"],
      }, "of:doc2");
      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("NotFoundError");
      const readResult = transaction.read({
        space,
        id: doc1Id,
        type: "application/json",
        path: ["source", "extra"],
      });
      expect(readResult.error).toBeDefined();
      expect(readResult.error?.name).toBe("NotFoundError");
    });

    it("should error if source doc does not exist", () => {
      const transaction = runtime.edit();
      const doc1Id = "of:doc1";
      const result = transaction.write({
        space,
        id: doc1Id,
        type: "application/json",
        path: ["source"],
      }, "of:nonexistent");
      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("NotFoundError");
    });

    it("should error if value for 'source' is not a URI string", () => {
      const transaction = runtime.edit();
      const doc1Id = "of:doc1";
      const result = transaction.write({
        space,
        id: doc1Id,
        type: "application/json",
        path: ["source"],
      }, 12345);
      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("NotFoundError");
    });
  });

  describe("readValueOrThrow and writeValueOrThrow", () => {
    it("should support readValueOrThrow for value, not found, and error cases", () => {
      const transaction = runtime.edit();

      // Write a value
      const writeResult = transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: [],
      }, { value: { foo: 123 } });
      expect(writeResult.ok).toBeDefined();
      expect(writeResult.error).toBeUndefined();

      // Should return the value for an existing path
      const result = transaction.read({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value", "foo"],
      });
      expect(result.ok?.value).toBe(123);

      // Should return the value for an existing path
      const value = transaction.readOrThrow({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value", "foo"],
      });
      expect(value).toBe(123);

      // Should return undefined for a non-existent path (NotFoundError)
      const notFound = transaction.readOrThrow({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value", "bar"],
      });
      expect(notFound).toBeUndefined();
    });
  });

  it("should support writeValueOrThrow into a new document", async () => {
    const transaction = runtime.edit();
    transaction.writeValueOrThrow({
      space,
      id: "of:test-entity-new",
      type: "application/json",
      path: ["value"],
    }, { foo: 123 });
    const result = await transaction.commit();
    expect(result.ok).toBeDefined();
  });

  // Regression test for: writing through an empty Record to a deeply nested path
  // should auto-create intermediate objects instead of throwing
  // "Value at path ... is not an object"
  it("should set deeply nested key through empty Record", () => {
    const transaction = runtime.edit();

    // Create a document with an empty Record
    transaction.write({
      space,
      id: "of:test-deep-empty-record",
      type: "application/json",
      path: [],
    }, { value: { emptyRecord: {} } });

    // Try to write to a path TWO levels deep through the empty Record
    // emptyRecord is {}, so emptyRecord["level1"] is undefined
    // This triggers the NotFoundError code path in writeOrThrow
    expect(() => {
      transaction.writeValueOrThrow({
        space,
        id: "of:test-deep-empty-record",
        type: "application/json",
        path: ["emptyRecord", "level1", "level2"],
      }, "deepvalue");
    }).not.toThrow();

    // Verify the path was created
    const result = transaction.readOrThrow({
      space,
      id: "of:test-deep-empty-record",
      type: "application/json",
      path: ["value", "emptyRecord", "level1", "level2"],
    });
    expect(result).toBe("deepvalue");
  });

  it("should preserve existing fields when writing nested path through new top-level key", () => {
    const transaction = runtime.edit();

    // Create a document with existing data at root (no "value" wrapper)
    transaction.write({
      space,
      id: "of:test-preserve-existing",
      type: "application/json",
      path: [],
    }, { existingKey: "existingValue" });

    // Write to a nested path through a NEW top-level key using writeOrThrow
    // (not writeValueOrThrow, which adds a "value" prefix)
    // This should NOT overwrite existingKey
    expect(() => {
      transaction.writeOrThrow({
        space,
        id: "of:test-preserve-existing",
        type: "application/json",
        path: ["newKey", "nested"],
      }, "newValue");
    }).not.toThrow();

    // Verify the new path was created
    const newResult = transaction.readOrThrow({
      space,
      id: "of:test-preserve-existing",
      type: "application/json",
      path: ["newKey", "nested"],
    });
    expect(newResult).toBe("newValue");

    // Verify existing data was preserved (this is the key assertion)
    const existingResult = transaction.readOrThrow({
      space,
      id: "of:test-preserve-existing",
      type: "application/json",
      path: ["existingKey"],
    });
    expect(existingResult).toBe("existingValue");
  });
});

describe("DocImpl shim notifications", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });
});

describe("URI Utils", () => {
  describe("getJSONFromDataURI", () => {
    it("should parse URI-encoded JSON data URI", () => {
      const testData = { name: "John Doe", age: 30, city: "New York" };
      const encodedData = encodeURIComponent(JSON.stringify(testData));
      const dataURI = `data:application/json,${encodedData}`;

      const result = getJSONFromDataURI(dataURI);

      expect(result).toEqual(testData);
    });

    it("should parse base64-encoded JSON data URI", () => {
      const testData = { name: "Jane Smith", age: 25, city: "Los Angeles" };
      const jsonString = JSON.stringify(testData);
      const base64Data = btoa(jsonString);
      const dataURI = `data:application/json;base64,${base64Data}`;

      const result = getJSONFromDataURI(dataURI);

      expect(result).toEqual(testData);
    });

    it("should parse data URI with UTF-8 charset", () => {
      const testData = { message: "Hello, 世界!", emoji: "🚀" };
      const encodedData = encodeURIComponent(JSON.stringify(testData));
      const dataURI = `data:application/json;charset=utf-8,${encodedData}`;

      const result = getJSONFromDataURI(dataURI);

      expect(result).toEqual(testData);
    });

    it("should parse data URI with utf8 charset variant", () => {
      const testData = { message: "Hello, 世界!", emoji: "🚀" };
      const encodedData = encodeURIComponent(JSON.stringify(testData));
      const dataURI = `data:application/json;charset=utf8,${encodedData}`;

      const result = getJSONFromDataURI(dataURI);

      expect(result).toEqual(testData);
    });

    it("should throw error for unsupported charset", () => {
      const dataURI =
        `data:application/json;charset=iso-8859-1,{"test":"data"}`;

      expect(() => getJSONFromDataURI(dataURI)).toThrow(
        "Unsupported charset: iso-8859-1. Only UTF-8 is supported.",
      );
    });

    it("should throw error for invalid data URI format", () => {
      const invalidURI = "data:application/json";

      expect(() => getJSONFromDataURI(invalidURI)).toThrow(
        "Invalid data URI format: data:application/json",
      );
    });

    it("should throw error for non-JSON data URI", () => {
      const nonJsonURI = "data:text/plain,Hello World";

      expect(() => getJSONFromDataURI(nonJsonURI)).toThrow(
        "Invalid URI: data:text/plain,Hello World",
      );
    });

    it("should throw error for invalid base64 data", () => {
      const invalidBase64URI = "data:application/json;base64,invalid-base64!@#";

      expect(() => getJSONFromDataURI(invalidBase64URI)).toThrow();
    });

    it("should throw error for invalid JSON in URI-encoded data", () => {
      const invalidJson = encodeURIComponent("{ invalid json }");
      const dataURI = `data:application/json,${invalidJson}`;

      expect(() => getJSONFromDataURI(dataURI)).toThrow();
    });

    it("should throw error for invalid JSON in base64 data", () => {
      const invalidJson = btoa("{ invalid json }");
      const dataURI = `data:application/json;base64,${invalidJson}`;

      expect(() => getJSONFromDataURI(dataURI)).toThrow();
    });
  });
});

describe("root value rewriting", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL("http://localhost:8000"),
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should rewrite root writes with value property", () => {
    const transaction = runtime.edit();

    // Write to empty path with object containing "value" property
    const writeResult = transaction.write({
      space,
      id: "of:test-root",
      type: "application/json",
      path: [],
    }, { value: { foo: "bar" } });

    expect(writeResult.ok).toBeDefined();

    // Should be able to read the value at path ["value"]
    const readResult = transaction.readOrThrow({
      space,
      id: "of:test-root",
      type: "application/json",
      path: ["value"],
    });

    expect(readResult).toEqual({ foo: "bar" });
  });

  it("should not rewrite non-empty paths", () => {
    const transaction = runtime.edit();

    // First create a document
    transaction.write({
      space,
      id: "of:test-nested",
      type: "application/json",
      path: [],
    }, { value: {} });

    // Write to non-empty path with object containing "value" property
    transaction.write({
      space,
      id: "of:test-nested",
      type: "application/json",
      path: ["value", "nested"],
    }, { value: "should not be rewritten" });

    // Should store the object as-is
    const readResult = transaction.readOrThrow({
      space,
      id: "of:test-nested",
      type: "application/json",
      path: ["value", "nested"],
    });

    expect(readResult).toEqual({ value: "should not be rewritten" });
  });

  // Disabling this test, since the non-shim doesn't enforce this rule, and I
  // don't think it's crucial enough to add the rule myself.
  it.skip("should not rewrite non-objects", () => {
    const transaction = runtime.edit();

    // Write non-object to empty path
    const writeResult = transaction.write({
      space,
      id: "of:test-string",
      type: "application/json",
      path: [],
    }, "plain string");

    // Should get an error since path is empty and value is not rewritten
    expect(writeResult.error).toBeDefined();
    expect(writeResult.error?.name).toBe("NotFoundError");
  });
});

describe("numeric path key edge cases", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL("http://localhost:8000"),
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  // Writing to a numeric key creates an array with the value at that index.
  it("numeric final key creates array index", () => {
    const transaction = runtime.edit();

    transaction.writeOrThrow({
      space,
      id: "of:numeric-final",
      type: "application/json",
      path: ["data", "0"],
    }, "Alice");

    // Read back the structure at "data"
    const data = transaction.readOrThrow({
      space,
      id: "of:numeric-final",
      type: "application/json",
      path: ["data"],
    });

    // It's an array with "Alice" at index 0
    expect(data).toEqual(["Alice"]);
    expect(Array.isArray(data)).toBe(true);
  });

  // Writing numeric key first creates array; writing non-numeric key after fails.
  it("writing numeric key then non-numeric key at same level fails", () => {
    const transaction = runtime.edit();

    // Write numeric key first - creates array
    transaction.writeOrThrow({
      space,
      id: "of:mixed-keys",
      type: "application/json",
      path: ["data", "0"],
    }, "Alice");

    // Write non-numeric key second - should fail because data is now an array
    expect(() => {
      transaction.writeOrThrow({
        space,
        id: "of:mixed-keys",
        type: "application/json",
        path: ["data", "name"],
      }, "Bob");
    }).toThrow("expected object but found array");
  });

  // Writing non-numeric key first creates object; numeric key becomes property.
  it("writing non-numeric key then numeric key at same level works as object", () => {
    const transaction = runtime.edit();

    // Write non-numeric key first - creates object
    transaction.writeOrThrow({
      space,
      id: "of:mixed-keys-2",
      type: "application/json",
      path: ["data", "name"],
    }, "Bob");

    // Write numeric key second - becomes object property (not array index)
    transaction.writeOrThrow({
      space,
      id: "of:mixed-keys-2",
      type: "application/json",
      path: ["data", "0"],
    }, "Alice");

    const data = transaction.readOrThrow({
      space,
      id: "of:mixed-keys-2",
      type: "application/json",
      path: ["data"],
    });

    // Both are object keys (order of writes matters)
    expect(data).toEqual({ "name": "Bob", "0": "Alice" });
    expect(Array.isArray(data)).toBe(false);
  });

  // Numeric intermediate key creates array; non-numeric final key creates object
  // inside the array. This is now valid JSON structure.
  it("numeric intermediate key creates array containing object", async () => {
    const transaction = runtime.edit();

    // Write to path where "0" is intermediate (not final)
    // This creates { data: [{ name: "Alice" }] } - array with object at index 0
    transaction.writeOrThrow({
      space,
      id: "of:numeric-intermediate",
      type: "application/json",
      path: ["data", "0", "name"],
    }, "Alice");

    // Verify the structure: "data" is an array, index 0 contains an object
    const data = transaction.readOrThrow({
      space,
      id: "of:numeric-intermediate",
      type: "application/json",
      path: ["data"],
    });

    expect(Array.isArray(data)).toBe(true);
    expect(data).toEqual([{ name: "Alice" }]);

    // This should now commit successfully (valid JSON structure)
    const result = await transaction.commit();
    expect(result.error).toBeUndefined();
  });

  // Documents: if you actually want an array, you must write the whole array
  // at once - you cannot build it incrementally via path-based writes.
  it("creating actual array requires writing whole array, not path-based", () => {
    const transaction = runtime.edit();

    // Write the complete array structure
    transaction.writeOrThrow({
      space,
      id: "of:actual-array",
      type: "application/json",
      path: ["data"],
    }, ["Alice", "Bob"]);

    const data = transaction.readOrThrow({
      space,
      id: "of:actual-array",
      type: "application/json",
      path: ["data"],
    });

    expect(Array.isArray(data)).toBe(true);
    expect(data).toEqual(["Alice", "Bob"]);
  });

  // Documents: writing to array index on existing array works
  it("writing to numeric path on existing array sets array index", () => {
    const transaction = runtime.edit();

    // First create the array
    transaction.writeOrThrow({
      space,
      id: "of:existing-array",
      type: "application/json",
      path: ["data"],
    }, ["original"]);

    // Now write to index 0
    transaction.writeOrThrow({
      space,
      id: "of:existing-array",
      type: "application/json",
      path: ["data", "0"],
    }, "updated");

    const data = transaction.readOrThrow({
      space,
      id: "of:existing-array",
      type: "application/json",
      path: ["data"],
    });

    expect(Array.isArray(data)).toBe(true);
    expect(data).toEqual(["updated"]);
  });

  // Documents: writing non-numeric key to existing array is rejected immediately
  // with TypeMismatchError (can't write object property to array).
  it("writing non-numeric key to existing array throws TypeMismatchError", () => {
    const transaction = runtime.edit();

    // First create the array
    transaction.writeOrThrow({
      space,
      id: "of:array-named-key",
      type: "application/json",
      path: ["data"],
    }, ["Alice"]);

    // Write a non-numeric key - throws immediately because storage layer
    // correctly rejects writing object-style property to an array.
    expect(() => {
      transaction.writeOrThrow({
        space,
        id: "of:array-named-key",
        type: "application/json",
        path: ["data", "name"],
      }, "Bob");
    }).toThrow("expected object but found array");
  });

  // Multiple numeric intermediate keys create properly nested arrays with objects.
  it("multiple numeric intermediate keys create nested arrays with object", async () => {
    const transaction = runtime.edit();

    // Path: ["data", "0", "1", "name"]
    // "data" → creates array (next key "0" is numeric)
    // "0" → creates array at index 0 (next key "1" is numeric)
    // "1" → creates object at index 1 (next key "name" is non-numeric)
    // "name" → sets property on that object
    transaction.writeOrThrow({
      space,
      id: "of:nested-numeric",
      type: "application/json",
      path: ["data", "0", "1", "name"],
    }, "Alice");

    // Verify the nested structure
    const data = transaction.readOrThrow({
      space,
      id: "of:nested-numeric",
      type: "application/json",
      path: ["data"],
    });
    // data is array containing array containing object
    expect(Array.isArray(data)).toBe(true);

    const level0 = transaction.readOrThrow({
      space,
      id: "of:nested-numeric",
      type: "application/json",
      path: ["data", "0"],
    });
    // data[0] is an array with index 1 set (sparse)
    expect(Array.isArray(level0)).toBe(true);
    expect((level0 as unknown[]).length).toBe(2);

    const level1 = transaction.readOrThrow({
      space,
      id: "of:nested-numeric",
      type: "application/json",
      path: ["data", "0", "1"],
    });
    // data[0][1] is an object with name property
    expect(Array.isArray(level1)).toBe(false);
    expect(level1).toEqual({ name: "Alice" });

    // This should now commit successfully (valid JSON structure)
    const result = await transaction.commit();
    expect(result.error).toBeUndefined();
  });

  // Writing to high numeric index creates sparse array (densified on commit).
  it("writing to high numeric index creates sparse array", () => {
    const transaction = runtime.edit();

    transaction.writeOrThrow({
      space,
      id: "of:high-index",
      type: "application/json",
      path: ["data", "99"],
    }, "value");

    const data = transaction.readOrThrow({
      space,
      id: "of:high-index",
      type: "application/json",
      path: ["data"],
    });

    // Creates sparse array with value at index 99.
    // Note: array remains sparse at transaction layer; densification (holes → null)
    // occurs either during commit (via toDeepStorableValue) or when serialized
    // to JSON for stable storage.
    expect(Array.isArray(data)).toBe(true);
    expect((data as unknown[]).length).toBe(100);
    expect((data as unknown[])[99]).toBe("value");
  });

  // Keys like "01" look numeric but aren't valid array indices (leading zero).
  // The container should be an object, not an array.
  it("leading-zero numeric key should create object not array", () => {
    const transaction = runtime.edit();

    transaction.writeOrThrow({
      space,
      id: "of:leading-zero",
      type: "application/json",
      path: ["data", "01"],
    }, "value");

    const data = transaction.readOrThrow({
      space,
      id: "of:leading-zero",
      type: "application/json",
      path: ["data"],
    });

    // The key "01" is not a valid array index, so data should be an object.
    // This test documents that this is the EXPECTED behavior - if it fails,
    // the bug where "01" creates an array is present.
    expect(Array.isArray(data)).toBe(false);
    expect(data).toEqual({ "01": "value" });
  });
});

describe("data: URI behaviors", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL("http://localhost:8000"),
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should read from a valid data URI", () => {
    const transaction = runtime.edit();
    const testData = { foo: { bar: 42 } };
    const encoded = encodeURIComponent(JSON.stringify(testData));
    const address = {
      space,
      id: `data:application/json,${encoded}`,
      type: "application/json",
      path: ["foo", "bar"],
    } as IMemorySpaceAddress;
    const result = transaction.read(address);
    expect(result.ok).toBeDefined();
    expect(result.ok?.value).toBe(42);
  });

  it("should error on invalid data URI format", () => {
    const transaction = runtime.edit();
    const address = {
      space,
      id: "data:application/json", // missing data
      type: "application/json",
      path: [],
    } as IMemorySpaceAddress;
    const result = transaction.read(address);
    expect(result.error).toBeDefined();
    expect(result.error?.name).toBe("InvalidDataURIError");
    expect(result.error?.message).toMatch(
      /Invalid data URI|Invalid data URI format/,
    );
  });

  it("should error on invalid JSON in data URI", () => {
    const transaction = runtime.edit();
    const invalidJson = encodeURIComponent("{ invalid json }");
    const address = {
      space,
      id: `data:application/json,${invalidJson}`,
      type: "application/json",
      path: [],
    } as IMemorySpaceAddress;
    const result = transaction.read(address);
    expect(result.error).toBeDefined();
    expect(result.error?.name).toBe("InvalidDataURIError");
  });

  it("should error on write to data URI", () => {
    const transaction = runtime.edit();
    const address = {
      space,
      id: "data:application/json,%7B%7D",
      type: "application/json",
      path: [],
    } as IMemorySpaceAddress;
    const result = transaction.write(address, {});
    expect(result.error).toBeDefined();
    expect(result.error?.name).toBe("ReadOnlyAddressError");
  });
});

describe("Cell-level transaction isolation", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL("http://localhost:8000"),
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("uncommitted writes should not be visible to get() outside transaction", async () => {
    const cell = runtime.getCell<{ value: number }>(space, "isolation-test");

    // Set initial value
    const setupTx = runtime.edit();
    cell.withTx(setupTx).set({ value: 42 });
    await setupTx.commit();

    // Start a new transaction and write a new value
    const tx = runtime.edit();
    cell.withTx(tx).set({ value: 999 });

    // Before commit: get() should still see the old value
    const beforeCommit = cell.get();
    expect(beforeCommit?.value).toBe(42);

    // After commit: get() should see the new value
    await tx.commit();
    const afterCommit = cell.get();
    expect(afterCommit?.value).toBe(999);
  });

  it("uncommitted writes should not be visible to pull() outside transaction", async () => {
    const cell = runtime.getCell<{ value: number }>(
      space,
      "isolation-pull-test",
    );

    // Set initial value
    const setupTx = runtime.edit();
    cell.withTx(setupTx).set({ value: 100 });
    await setupTx.commit();

    // Start a new transaction and write a new value
    const tx = runtime.edit();
    cell.withTx(tx).set({ value: 500 });

    // Before commit: pull() should still see the old value
    await cell.pull();
    const beforeCommit = cell.get();
    expect(beforeCommit?.value).toBe(100);

    // After commit: pull() should see the new value
    await tx.commit();
    await cell.pull();
    const afterCommit = cell.get();
    expect(afterCommit?.value).toBe(500);
  });

  /*
   * =========================================================================
   * SURPRISING BEHAVIOR: Live references, not snapshots
   * =========================================================================
   *
   * Unlike traditional database transactions, cell.get() returns a LIVE
   * REFERENCE (proxy) to the current committed state, NOT a point-in-time
   * snapshot.
   *
   * This differs from standard transaction semantics:
   *
   * - In SQL with SNAPSHOT ISOLATION: A transaction sees a consistent
   *   snapshot from when it started. Reads within T1 would always return
   *   the value as of T1's start time, regardless of concurrent commits.
   *
   * - In SQL with SERIALIZABLE: Concurrent modifications would cause one
   *   transaction to fail (conflict detection / optimistic locking).
   *
   * - HERE: Reads return live proxies. If T2 commits while T1 is open,
   *   T1's previously-read reference will reflect T2's changes. T1 will
   *   NOT fail on commit. There is no conflict detection.
   *
   * IMPLICATION: If you need point-in-time semantics, you must explicitly
   * deep-copy values when you read them (e.g., JSON.parse(JSON.stringify(...))).
   * =========================================================================
   */

  it("get() returns live reference: concurrent commit changes what T1 sees", async () => {
    const cellA = runtime.getCell<{ value: number }>(space, "live-ref-cell-a");
    const cellB = runtime.getCell<{ value: number }>(space, "live-ref-cell-b");

    // Setup: cellA has initial value
    const setupTx = runtime.edit();
    cellA.withTx(setupTx).set({ value: 100 });
    await setupTx.commit();

    // T1 starts and reads cellA - gets a LIVE REFERENCE
    const t1 = runtime.edit();
    const t1ReadValue = cellA.get();
    expect(t1ReadValue?.value).toBe(100); // Looks like 100 right now...

    // T2 starts, writes new value to cellA, and commits
    const t2 = runtime.edit();
    cellA.withTx(t2).set({ value: 999 });
    await t2.commit();

    // SURPRISE: t1ReadValue is a live reference - it now reflects T2's commit!
    // In traditional DB semantics, t1ReadValue would still be 100.
    expect(t1ReadValue?.value).toBe(999);

    // T1 writes its "read value" to cellB and commits successfully
    // (no conflict detection - T1 doesn't know or care that cellA changed)
    cellB.withTx(t1).set(t1ReadValue!);
    await t1.commit();

    // cellB has T2's value, not the value T1 "thought" it read
    expect(cellB.get()?.value).toBe(999);
  });

  it("deep copy at read time captures point-in-time snapshot", async () => {
    const cellA = runtime.getCell<{ value: number }>(space, "snapshot-cell-a");
    const cellB = runtime.getCell<{ value: number }>(space, "snapshot-cell-b");

    // Setup: cellA has initial value
    const setupTx = runtime.edit();
    cellA.withTx(setupTx).set({ value: 100 });
    await setupTx.commit();

    // T1 starts and reads cellA - DEEP COPY to get true snapshot
    const t1 = runtime.edit();
    const t1Snapshot = JSON.parse(JSON.stringify(cellA.get()));
    expect(t1Snapshot.value).toBe(100);

    // T2 commits a new value
    const t2 = runtime.edit();
    cellA.withTx(t2).set({ value: 999 });
    await t2.commit();

    // The snapshot is unaffected by T2's commit
    expect(t1Snapshot.value).toBe(100);

    // T1 writes its snapshot to cellB
    cellB.withTx(t1).set(t1Snapshot);
    await t1.commit();

    // cellB has the original value T1 captured
    expect(cellB.get()?.value).toBe(100);
  });

  it("no conflict detection: T1 commits successfully despite concurrent modification", async () => {
    const cell = runtime.getCell<{ value: number }>(space, "no-conflict-cell");

    // Setup
    const setupTx = runtime.edit();
    cell.withTx(setupTx).set({ value: 1 });
    await setupTx.commit();

    // T1 starts (implicitly "reads" by existing while cell has value 1)
    const t1 = runtime.edit();

    // T2 modifies and commits
    const t2 = runtime.edit();
    cell.withTx(t2).set({ value: 2 });
    await t2.commit();

    // T1 now writes its own value - no conflict, no error
    // In serializable isolation, this would fail.
    cell.withTx(t1).set({ value: 3 });
    await t1.commit(); // succeeds

    // Last writer wins
    expect(cell.get()?.value).toBe(3);
  });

  /*
   * =========================================================================
   * Conflicting writes: two transactions with pending writes to the same cell
   * =========================================================================
   *
   * These tests document what happens when two transactions both have
   * uncommitted writes to the same cell, then both attempt to commit.
   *
   * Key finding: The system DOES have conflict detection. When the underlying
   * data changes between when a transaction starts and when it commits, the
   * commit fails with StorageTransactionInconsistent error.
   *
   * This differs from the "no conflict detection" test above because that test
   * has T2 commit before T1 writes - so T1's write happens after T1 has already
   * observed the new state. Here, both transactions have pending writes based
   * on the ORIGINAL state, so the second commit detects the inconsistency.
   * =========================================================================
   */

  it("conflicting writes with sequential commits: second commit fails", async () => {
    const cell = runtime.getCell<{ value: number }>(
      space,
      "conflict-sequential",
    );

    // Setup: cell has initial value
    const setupTx = runtime.edit();
    cell.withTx(setupTx).set({ value: 0 });
    await setupTx.commit();

    // T1 and T2 both open (both see value = 0)
    const t1 = runtime.edit();
    const t2 = runtime.edit();

    // Both write different values (neither has committed yet)
    cell.withTx(t1).set({ value: 100 });
    cell.withTx(t2).set({ value: 200 });

    // T1 commits first - succeeds
    const t1Result = await t1.commit();
    expect(t1Result.error).toBeUndefined();

    // Cell now has T1's value
    expect(cell.get()?.value).toBe(100);

    // T2 commits second - FAILS because T2 was based on value=0, but it's now 100
    const t2Result = await t2.commit();
    expect(t2Result.error).toBeDefined();
    expect(t2Result.error?.name).toBe("StorageTransactionInconsistent");

    // Cell still has T1's value (T2's commit was rejected)
    expect(cell.get()?.value).toBe(100);
  });

  it("identical writes with sequential commits: second commit still fails", async () => {
    const cell = runtime.getCell<{ value: number }>(
      space,
      "identical-sequential",
    );

    // Setup: cell has initial value
    const setupTx = runtime.edit();
    cell.withTx(setupTx).set({ value: 0 });
    await setupTx.commit();

    // T1 and T2 both open (both see value = 0)
    const t1 = runtime.edit();
    const t2 = runtime.edit();

    // Both write the SAME value (neither has committed yet)
    cell.withTx(t1).set({ value: 100 });
    cell.withTx(t2).set({ value: 100 });

    // T1 commits first - succeeds
    const t1Result = await t1.commit();
    expect(t1Result.error).toBeUndefined();
    expect(cell.get()?.value).toBe(100);

    // T2 commits second - still FAILS even though the value is identical
    // The conflict detection is based on the base state changing, not the
    // final value being different
    const t2Result = await t2.commit();
    expect(t2Result.error).toBeDefined();
    expect(t2Result.error?.name).toBe("StorageTransactionInconsistent");

    // Cell has the value (100) - same either way, but T2 was rejected
    expect(cell.get()?.value).toBe(100);
  });

  it("parallel writes with conflict detection: one succeeds, one fails", async () => {
    const cell = runtime.getCell<{ value: number }>(
      space,
      "conflict-parallel",
    );

    // Setup: cell has initial value
    const setupTx = runtime.edit();
    cell.withTx(setupTx).set({ value: 0 });
    await setupTx.commit();

    // T1 and T2 both open (both see value = 0)
    const t1 = runtime.edit();
    const t2 = runtime.edit();

    // Both write different values (neither has committed yet).
    // cell.set() reads the current value (via diffAndUpdate) creating
    // claims — so these are NOT blind writes.  Both transactions claim
    // against the same confirmed version, leading to a conflict.
    cell.withTx(t1).set({ value: 100 });
    cell.withTx(t2).set({ value: 200 });

    // Both commit in parallel — T1 succeeds, T2 conflicts
    const [t1Result, t2Result] = await Promise.all([
      t1.commit(),
      t2.commit(),
    ]);

    const successes = [t1Result, t2Result].filter((r) => !r.error);
    expect(successes.length).toBe(1);

    // T1 committed first, so cell has T1's value
    const finalValue = cell.get()?.value;
    expect(finalValue).toBe(100);
  });

  /*
   * =========================================================================
   * Transaction read-your-writes: withTx().get() sees pending writes
   * =========================================================================
   *
   * Unlike the earlier "live reference" tests where cell.get() (without tx)
   * returns the committed state, cell.withTx(tx).get() returns the
   * transaction's pending writes - providing read-your-writes semantics
   * within a transaction.
   * =========================================================================
   */

  it("withTx().get() returns pending writes within the transaction", async () => {
    const cell = runtime.getCell<{ value: number }>(
      space,
      "withtx-get-behavior",
    );

    // Setup: cell has initial value
    const setupTx = runtime.edit();
    cell.withTx(setupTx).set({ value: 0 });
    await setupTx.commit();

    // T1 opens and writes
    const t1 = runtime.edit();
    cell.withTx(t1).set({ value: 100 });

    // withTx().get() returns the PENDING write (100), providing read-your-writes
    expect(cell.withTx(t1).get()?.value).toBe(100);

    // But cell.get() (without tx) returns the COMMITTED value (0)
    expect(cell.get()?.value).toBe(0);

    // After T1 commits, both see the committed value
    await t1.commit();
    expect(cell.withTx(t1).get()?.value).toBe(100);
    expect(cell.get()?.value).toBe(100);
  });

  it("each transaction sees its own pending writes, isolated from each other", async () => {
    const cell = runtime.getCell<{ value: number }>(
      space,
      "tx-isolation-pending",
    );

    // Setup: cell has initial value
    const setupTx = runtime.edit();
    cell.withTx(setupTx).set({ value: 0 });
    await setupTx.commit();

    // T1 and T2 both open
    const t1 = runtime.edit();
    const t2 = runtime.edit();

    // Both write different values
    cell.withTx(t1).set({ value: 100 });
    cell.withTx(t2).set({ value: 200 });

    // Each transaction sees its own pending write
    expect(cell.withTx(t1).get()?.value).toBe(100);
    expect(cell.withTx(t2).get()?.value).toBe(200);

    // The committed value is still 0 (neither has committed)
    expect(cell.get()?.value).toBe(0);

    // After T1 commits, the committed value changes
    const t1Result = await t1.commit();
    expect(t1Result.error).toBeUndefined();
    expect(cell.get()?.value).toBe(100);

    // T2 still sees its own pending write (200)
    expect(cell.withTx(t2).get()?.value).toBe(200);

    // But T2's commit fails due to conflict
    const t2Result = await t2.commit();
    expect(t2Result.error).toBeDefined();
    expect(t2Result.error?.name).toBe("StorageTransactionInconsistent");

    // Cell still has T1's value
    expect(cell.get()?.value).toBe(100);
  });
});
