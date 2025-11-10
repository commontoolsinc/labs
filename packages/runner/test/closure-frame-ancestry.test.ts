import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Identity } from "@commontools/identity";

const signer = await Identity.fromPassphrase("test operator");

describe("Closure Frame Ancestry Checking", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let recipe: ReturnType<typeof createBuilder>["commontools"]["recipe"];
  let derive: ReturnType<typeof createBuilder>["commontools"]["derive"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const { commontools } = createBuilder(runtime);
    ({ recipe, derive } = commontools);
  });

  afterEach(async () => {
    await runtime?.dispose();
  });

  describe("Accessing grouped objects with derived keys", () => {
    it("should allow accessing derived grouped object with derived key in map callback", () => {
      // This pattern reproduces the bug: grouping items and then accessing
      // the grouped object with a derived key inside a map callback.
      // Without the frame ancestry fix, this throws:
      // "Accessing an opaque ref via closure is not supported"

      interface Item {
        id: string;
        category: string;
        value: number;
      }

      interface State {
        items: Item[];
      }

      const testRecipe = recipe<State>(
        {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  category: { type: "string" },
                  value: { type: "number" },
                },
                required: ["id", "category", "value"],
              },
            },
          },
          required: ["items"],
        } as const,
        (state) => {
          // Group items by category - created in recipe frame
          const groupedByCategory = derive(state.items, (items) => {
            const groups: Record<string, Item[]> = {};
            for (const item of items) {
              if (!groups[item.category]) groups[item.category] = [];
              groups[item.category].push(item);
            }
            return groups;
          });

          // Get sorted category names - created in recipe frame
          const categoryNames = derive(
            groupedByCategory,
            (groups) => Object.keys(groups).sort(),
          );

          // Map over categories - creates a new frame (map callback frame)
          const categorySums = categoryNames.map((categoryName) => {
            // Access grouped object with derived key - this crosses frame boundaries!
            // groupedByCategory is from recipe frame, categoryName is from map frame
            // The derive wrapping this access is created in map callback frame
            const itemsInCategory = derive(
              { groupedByCategory, categoryName },
              ({ groupedByCategory, categoryName }) =>
                groupedByCategory[categoryName] ?? [],
            );

            // Calculate sum for this category
            const sum = derive(
              itemsInCategory,
              (items) => items.reduce((acc, item) => acc + item.value, 0),
            );

            return { category: categoryName, sum };
          });

          return {
            categorySums,
          };
        },
      );

      // Build the recipe - this is where frame checking happens
      // The key test is that this doesn't throw a frame access error
      expect(() => {
        testRecipe.toJSON();
      }).not.toThrow();

      // If we get here without errors, the frame ancestry checking worked!
    });

    it("should allow nested map callbacks accessing outer frame cells", () => {
      // Even more complex: nested maps where inner map accesses cells from
      // multiple ancestor frames

      interface Item {
        id: string;
        group: string;
        subgroup: string;
      }

      interface State {
        items: Item[];
      }

      const testRecipe = recipe<State>(
        {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  group: { type: "string" },
                  subgroup: { type: "string" },
                },
                required: ["id", "group", "subgroup"],
              },
            },
          },
          required: ["items"],
        } as const,
        (state) => {
          // Create grouped data in recipe frame
          const groupedByGroup = derive(state.items, (items) => {
            const groups: Record<string, Item[]> = {};
            for (const item of items) {
              if (!groups[item.group]) groups[item.group] = [];
              groups[item.group].push(item);
            }
            return groups;
          });

          const groupNames = derive(
            groupedByGroup,
            (groups) => Object.keys(groups).sort(),
          );

          // Outer map - creates first child frame
          const result = groupNames.map((groupName) => {
            const itemsInGroup = derive(
              { groupedByGroup, groupName },
              ({ groupedByGroup, groupName }) =>
                groupedByGroup[groupName] ?? [],
            );

            const subgroupedItems = derive(itemsInGroup, (items) => {
              const subgroups: Record<string, Item[]> = {};
              for (const item of items) {
                if (!subgroups[item.subgroup]) subgroups[item.subgroup] = [];
                subgroups[item.subgroup].push(item);
              }
              return subgroups;
            });

            const subgroupNames = derive(
              subgroupedItems,
              (sg) => Object.keys(sg).sort(),
            );

            // Inner map - creates second child frame
            // Accesses cells from both parent frames
            const subgroupCounts = subgroupNames.map((subgroupName) => {
              const itemsInSubgroup = derive(
                { subgroupedItems, subgroupName },
                ({ subgroupedItems, subgroupName }) =>
                  subgroupedItems[subgroupName] ?? [],
              );

              const count = derive(
                itemsInSubgroup,
                (items) => items.length,
              );

              return { subgroup: subgroupName, count };
            });

            return { group: groupName, subgroups: subgroupCounts };
          });

          return { result };
        },
      );

      // Build the recipe - tests that nested frame access works
      // The key test is that this doesn't throw a frame access error
      expect(() => {
        testRecipe.toJSON();
      }).not.toThrow();

      // If we get here, nested frame ancestry checking worked!
    });
  });
});
