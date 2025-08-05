import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Runtime } from "../src/runtime.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { type Cell } from "../src/cell.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Array Index Setting (CT-731)", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should allow setting array elements by index without throwing", () => {
    // Create a cell with an array
    const arrayCell = runtime.getCell(space, "test-array", {
      type: "array",
      items: { type: "string" },
      default: ["first", "second", "third"],
    }, tx);

    // Test setting array element by index using key() method
    // This should work without throwing TypeMismatchError
    expect(() => {
      const firstElement = arrayCell.key(0);
      firstElement.set("updated first");
    }).not.toThrow(/is not a record/);
  });

  it("should handle deep array index access without TypeMismatchError", () => {
    // Create a cell with nested structure containing arrays
    const dataCell = runtime.getCell(space, "nested-data", {
      type: "object",
      properties: {
        users: {
          type: "array",
          items: {
            type: "object", 
            properties: {
              name: { type: "string" },
              tags: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
      },
      default: {
        users: [
          { name: "Alice", tags: ["admin", "developer"] },
          { name: "Bob", tags: ["user", "tester"] },
        ],
      },
    }, tx);

    // Test deep nested array index access: users/0/tags/1
    // This was the specific case that triggered CT-731
    expect(() => {
      const usersArray = dataCell.key("users");
      const firstUser = usersArray.key(0);
      const userTags = firstUser.key("tags");
      const secondTag = userTags.key(1);
      
      // This should not throw TypeMismatchError: "is not a record"
      secondTag.set("maintainer");
    }).not.toThrow(/is not a record/);
  });

  it("should not throw TypeMismatchError for simple array index access", () => {
    // This test specifically verifies that the CT-731 bug is fixed
    const dataCell = runtime.getCell(space, "bug-reproduction", {
      type: "object", 
      properties: {
        items: {
          type: "array",
          items: { type: "string" },
        },
      },
      default: { items: ["value1", "value2", "value3"] },
    }, tx);

    // This should NOT throw "TypeMismatchError: is not a record"
    expect(() => {
      const itemsArray = dataCell.key("items");
      const firstItem = itemsArray.key(0);
      firstItem.set("new value");
    }).not.toThrow(/is not a record/);
  });

  it("should fail gracefully when accessing non-existent array indices", () => {
    const arrayCell = runtime.getCell(space, "small-array", {
      type: "array",
      items: { type: "string" },
      default: ["only", "two"],
    }, tx);

    // Accessing index 5 on a 2-element array should not crash with the specific CT-731 error
    const fifthElement = arrayCell.key(5);
    
    expect(() => {
      fifthElement.set("new element");
    }).not.toThrow(/is not a record/); // The specific error from CT-731
  });
});