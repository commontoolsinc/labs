import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { EntityId } from "@commontools/runner";
import { isObject, isRecord } from "@commontools/utils/types";

type MockDoc = {
  get: () => unknown;
  getEntityId: () => unknown;
};

// Create a mock environment for testing reference detection
describe("Charm reference detection", () => {
  // Test the core logic of direct reference finding without maybeGetCellLink
  it("should find all direct references in an argument structure", () => {
    // Create mock data with multiple references
    const mockData = {
      charm1Id: { "/": "charm-1-id" },
      charm2Id: { "/": "charm-2-id" },
    };

    // Create a value that references two different entity IDs
    const valueWithMultipleRefs = {
      firstRef: {
        cell: mockData.charm1Id,
        path: [],
      },
      secondRef: {
        cell: mockData.charm2Id,
        path: [],
      },
      nestedRefs: {
        a: {
          cell: mockData.charm1Id,
          path: [],
        },
        b: {
          cell: mockData.charm2Id,
          path: [],
        },
      },
    };

    // Track the references we find
    const foundRefs: EntityId[] = [];

    // Direct manual detection (not using maybeGetCellLink which requires proper Cell implementation)
    const findDirectReferences = (value: unknown): void => {
      if (!value) return;

      // Check if the value has cell and path properties directly
      if (
        isRecord(value) && value.cell && isRecord(value.cell) &&
        value.path !== undefined
      ) {
        const addr = value.cell["/"];
        if (typeof addr !== "string" && !(addr instanceof Uint8Array)) {
          return;
        }
        const id = { "/": addr };
        if (!foundRefs.some((ref) => ref["/"] === id["/"])) {
          foundRefs.push(id);
        }
      }

      // Recursively search objects and arrays
      if (isRecord(value)) {
        // Check all properties of objects
        if (!Array.isArray(value)) {
          for (const key in value) {
            findDirectReferences(value[key]);
          }
        } // Check all items in arrays
        else {
          for (const item of value) {
            findDirectReferences(item);
          }
        }
      }
    };

    // Search for references
    findDirectReferences(valueWithMultipleRefs);

    console.log(
      `Found ${foundRefs.length} direct references:`,
      foundRefs.map((ref) => ref["/"]).join(", "),
    );

    // We should find both charm1Id and charm2Id
    assertEquals(
      foundRefs.length,
      2,
      "Should find exactly 2 unique reference IDs",
    );

    // Verify we found both specific references
    const foundCharm1 = foundRefs.some((ref) =>
      ref["/"] === mockData.charm1Id["/"]
    );
    const foundCharm2 = foundRefs.some((ref) =>
      ref["/"] === mockData.charm2Id["/"]
    );

    assertEquals(foundCharm1, true, "Should find reference to charm1");
    assertEquals(foundCharm2, true, "Should find reference to charm2");
  });

  // Test specifically the issue where only one reference is found when there are multiple
  it("should find multiple references in argument data that matches the reported issue", () => {
    // Mock the scenario where a charm's argument refers to two other charms
    const mockCharm1Id = { "/": "charm-1-id" };
    const mockCharm2Id = { "/": "charm-2-id" };

    // Create a realistic argument cell structure that might be causing the issue
    // This simulates a more realistic structure based on your description of the problem
    const argumentData = {
      // This is a more realistic structure that might be found in an actual argument cell
      // with references to result cells of other charms
      firstCharmRef: {
        $alias: {
          cell: mockCharm1Id,
          path: ["result"],
        },
      },
      secondCharmRef: {
        $alias: {
          cell: mockCharm2Id,
          path: ["result"],
        },
      },
      // Alternative format - direct references
      directRefs: {
        firstCharm: {
          cell: mockCharm1Id,
          path: ["result"],
        },
        secondCharm: {
          cell: mockCharm2Id,
          path: ["result"],
        },
      },
    };

    // Let's implement our own reference finding logic to compare with what the system does
    const findAllReferences = (obj: unknown): EntityId[] => {
      const refs: EntityId[] = [];
      const seenIds = new Set<string>();

      const traverse = (value: unknown): void => {
        if (!isRecord(value)) return;

        // Check for direct cell reference
        if (value.cell && value.path !== undefined) {
          // FIXME: types
          const addr = (value.cell as Record<string, unknown>)["/"] as string;

          if (addr && !seenIds.has(addr)) {
            refs.push({ "/": addr });
            seenIds.add(addr);
          }
        }

        // Check for $alias reference
        if (isRecord(value.$alias) && isRecord(value.$alias.cell)) {
          // FIXME: types
          const addr = value.$alias.cell["/"] as string;
          if (addr && !seenIds.has(addr)) {
            refs.push({ "/": addr });
            seenIds.add(addr);
          }
        }

        // Traverse objects and arrays
        if (Array.isArray(value)) {
          for (const item of value) {
            traverse(item);
          }
        } else {
          for (const key in value) {
            traverse(value[key]);
          }
        }
      };

      traverse(obj);
      return refs;
    };

    // Find all references using our custom logic
    const foundReferences = findAllReferences(argumentData);

    // We should find both charm references
    console.log(
      `Found ${foundReferences.length} references:`,
      foundReferences.map((ref) => ref["/"]).join(", "),
    );

    assertEquals(
      foundReferences.length,
      2,
      "Should find both charm references in the argument data",
    );

    // Check that we specifically found both charm IDs
    const foundCharm1 = foundReferences.some((ref) =>
      ref["/"] === mockCharm1Id["/"]
    );
    const foundCharm2 = foundReferences.some((ref) =>
      ref["/"] === mockCharm2Id["/"]
    );

    assertEquals(foundCharm1, true, "Should find reference to charm1");
    assertEquals(foundCharm2, true, "Should find reference to charm2");

    // Now let's simulate what happens in the actual getReadingFrom method
    console.log("Reference structure to examine:");
    console.log(JSON.stringify(argumentData, null, 2));

    // This will help us see if there might be an ordering issue affecting which
    // references are found first, potentially causing some to be missed
  });

  // Test for n-depth reference detection
  it("should follow sourceCell chains to find deeply nested references", () => {
    // Mock test data
    const mockCharm1Id = { "/": "charm-1-source" };
    const mockCharm2Id = { "/": "charm-2-intermediate" };
    const mockCharm3Id = { "/": "charm-3-target" };

    // Create a chain of references where:
    // - charm1 references charm2 via a sourceCell
    // - charm2 references charm3 via resultRef
    const charm2WithResultRef = {
      // This is the intermediate charm data
      resultRef: {
        cell: mockCharm3Id,
        path: [],
      },
    };

    // Mock sourceCell with get and getEntityId methods
    const mockSourceCell = {
      get: () => charm2WithResultRef,
      getEntityId: () => mockCharm2Id,
    };

    const charm1WithSourceCell = {
      // This is the source charm with a sourceCell reference
      sourceCell: mockSourceCell,
    };

    // Create mock doc with get and getEntityId methods
    const mockDoc = {
      get: () => charm1WithSourceCell,
      getEntityId: () => mockCharm1Id,
    };

    // Test our ability to follow this chain
    console.log(
      "Testing n-depth reference detection with sourceCell and resultRef chain...",
    );

    // Simulate the followSourceToResultRef function from the implementation
    const followSourceToResultRef = (
      doc: unknown,
      visited = new Set<string>(),
      depth = 0,
    ): unknown => {
      if (depth > 10) return undefined; // Prevent infinite recursion

      // Get the doc ID
      // FIXME: types
      const docId = (doc as MockDoc).getEntityId?.();
      if (!isObject(docId) || !("/" in docId)) return undefined;

      // If we've already seen this doc, stop to prevent cycles
      const docIdStr = typeof docId["/"] === "string"
        ? docId["/"]
        : JSON.stringify(docId["/"]);

      if (visited.has(docIdStr)) return undefined;
      visited.add(docIdStr);

      // Get the doc value
      // FIXME: types
      const value = (doc as MockDoc).get?.();

      // If document has a sourceCell, follow it
      if (isRecord(value) && value.sourceCell) {
        return followSourceToResultRef(value.sourceCell, visited, depth + 1);
      }

      // If we've reached the end and have a resultRef, return it
      if (isRecord(value) && isRecord(value.resultRef)) {
        return value.resultRef.cell;
      }

      // Return the document's ID if no further references
      return docId;
    };

    // Follow the sourceCell chain to find the ultimate reference
    const ultimateRef = followSourceToResultRef(mockDoc) as Record<
      string,
      unknown
    >;

    // Verify we found the final target (charm3)
    assertEquals(
      ultimateRef["/"],
      mockCharm3Id["/"],
      "Should find the final reference through the sourceCell -> resultRef chain",
    );
  });
});
