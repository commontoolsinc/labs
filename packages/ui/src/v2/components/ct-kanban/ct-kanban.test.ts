import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type KanbanColumn, type KanbanItem } from "./ct-kanban.ts";
import { type Cell } from "@commontools/runner";

/**
 * Test suite for CTKanban component interfaces and logic
 * Tests type definitions, data structures, and core functionality without DOM dependencies
 */
describe("CTKanban Logic Tests", () => {
  const sampleItems: KanbanItem[] = [
    {
      title: "Task 1",
      status: "todo",
      subtaskCount: 3,
    },
    {
      title: "Task 2",
      status: "in-progress",
      statusBadge: { text: "In Progress", icon: "⚡" },
    },
    {
      title: "Task 3",
      status: "done",
      done: true,
    },
  ];

  const customColumns: KanbanColumn[] = [
    { id: "backlog", title: "Backlog", status: "backlog", color: "#6b7280" },
    {
      id: "active",
      title: "Active",
      status: "active",
      color: "#3b82f6",
      maxItems: 3,
    },
    { id: "review", title: "Review", status: "review", color: "#8b5cf6" },
    {
      id: "completed",
      title: "Completed",
      status: "completed",
      color: "#10b981",
    },
  ];

  // Helper function to filter items by status (mimics component logic)
  function getColumnItems(items: KanbanItem[], status: string): KanbanItem[] {
    return items.filter((item) => item.status === status);
  }

  // Helper function to move items between statuses (mimics component logic)
  function moveItem(
    items: KanbanItem[],
    itemToMove: KanbanItem,
    toStatus: string,
  ): KanbanItem[] {
    return items.map((item) =>
      item === itemToMove ? { ...item, status: toStatus } : item
    );
  }

  describe("Type Definitions", () => {
    it("should define KanbanItem interface correctly", () => {
      const item: KanbanItem = {
        title: "Test Task",
        status: "todo",
        subtaskCount: 5,
        done: false,
      };

      expect(item.title).toBe("Test Task");
      expect(item.status).toBe("todo");
      expect(item.subtaskCount).toBe(5);
      expect(item.done).toBe(false);
    });

    it("should define KanbanColumn interface correctly", () => {
      const column: KanbanColumn = {
        id: "test-col",
        title: "Test Column",
        status: "test",
        maxItems: 10,
        color: "#ff0000",
        icon: "🚀",
      };

      expect(column.id).toBe("test-col");
      expect(column.title).toBe("Test Column");
      expect(column.status).toBe("test");
      expect(column.maxItems).toBe(10);
      expect(column.color).toBe("#ff0000");
      expect(column.icon).toBe("🚀");
    });

    it("should support optional properties in KanbanItem", () => {
      const minimalItem: KanbanItem = {
        title: "Minimal Task",
        status: "todo",
      };

      expect(minimalItem.title).toBe("Minimal Task");
      expect(minimalItem.status).toBe("todo");
      expect(minimalItem.done).toBeUndefined();
      expect(minimalItem.subtaskCount).toBeUndefined();
    });

    it("should support custom column configurations", () => {
      expect(customColumns).toHaveLength(4);
      expect(customColumns[0].status).toBe("backlog");
      expect(customColumns[1].maxItems).toBe(3);
      expect(customColumns[2].color).toBe("#8b5cf6");
      expect(customColumns[3].title).toBe("Completed");
    });
  });

  describe("Item Filtering Logic", () => {
    it("should filter items by status correctly", () => {
      const todoItems = getColumnItems(sampleItems, "todo");
      const progressItems = getColumnItems(sampleItems, "in-progress");
      const doneItems = getColumnItems(sampleItems, "done");

      expect(todoItems).toHaveLength(1);
      expect(todoItems[0].title).toBe("Task 1");
      expect(progressItems).toHaveLength(1);
      expect(progressItems[0].title).toBe("Task 2");
      expect(doneItems).toHaveLength(1);
      expect(doneItems[0].title).toBe("Task 3");
    });

    it("should handle empty item arrays", () => {
      const todoItems = getColumnItems([], "todo");
      const progressItems = getColumnItems([], "in-progress");
      const doneItems = getColumnItems([], "done");

      expect(todoItems).toHaveLength(0);
      expect(progressItems).toHaveLength(0);
      expect(doneItems).toHaveLength(0);
    });

    it("should handle non-existent status", () => {
      const items = getColumnItems(sampleItems, "nonexistent");
      expect(items).toHaveLength(0);
    });

    it("should maintain item properties when filtering", () => {
      const todoItems = getColumnItems(sampleItems, "todo");
      expect(todoItems[0].subtaskCount).toBe(3);

      const progressItems = getColumnItems(sampleItems, "in-progress");
      expect(progressItems[0].statusBadge?.text).toBe("In Progress");
      expect(progressItems[0].statusBadge?.icon).toBe("⚡");

      const doneItems = getColumnItems(sampleItems, "done");
      expect(doneItems[0].done).toBe(true);
    });
  });

  describe("Item Movement Logic", () => {
    it("should move items between statuses", () => {
      const todoItem = sampleItems.find((item) => item.status === "todo")!;
      const updatedItems = moveItem(sampleItems, todoItem, "in-progress");

      const todoItems = getColumnItems(updatedItems, "todo");
      const progressItems = getColumnItems(updatedItems, "in-progress");

      expect(todoItems).toHaveLength(0);
      expect(progressItems).toHaveLength(2);

      // Find the moved item
      const movedItem = progressItems.find((item) => item.title === "Task 1");
      expect(movedItem?.status).toBe("in-progress");
      expect(movedItem?.title).toBe("Task 1");
    });

    it("should preserve item properties when moving", () => {
      const todoItem = sampleItems.find((item) => item.status === "todo")!;
      const originalSubtaskCount = todoItem.subtaskCount;

      const updatedItems = moveItem(sampleItems, todoItem, "done");
      const doneItems = getColumnItems(updatedItems, "done");

      const movedItem = doneItems.find((item) => item.title === "Task 1");
      expect(movedItem?.title).toBe("Task 1");
      expect(movedItem?.subtaskCount).toBe(originalSubtaskCount);
      expect(movedItem?.status).toBe("done");
    });

    it("should not affect other items when moving", () => {
      const todoItem = sampleItems.find((item) => item.status === "todo")!;
      const updatedItems = moveItem(sampleItems, todoItem, "done");

      // Other items should remain unchanged
      const progressItem = updatedItems.find((item) => item.title === "Task 2");
      const originalDoneItem = updatedItems.find((item) =>
        item.title === "Task 3"
      );

      expect(progressItem?.status).toBe("in-progress");
      expect(progressItem?.statusBadge?.text).toBe("In Progress");
      expect(originalDoneItem?.status).toBe("done");
      expect(originalDoneItem?.done).toBe(true);
    });

    it("should handle moving item to same status", () => {
      const todoItem = sampleItems.find((item) => item.status === "todo")!;
      const updatedItems = moveItem(sampleItems, todoItem, "todo");

      // Should remain the same
      expect(getColumnItems(updatedItems, "todo")).toHaveLength(1);
      expect(getColumnItems(updatedItems, "in-progress")).toHaveLength(1);
      expect(getColumnItems(updatedItems, "done")).toHaveLength(1);
    });
  });

  describe("Column Configuration Logic", () => {
    it("should support various column configurations", () => {
      // Test default columns structure
      const defaultColumns = [
        { id: "todo", title: "Todo", status: "todo", color: "#fbbf24" },
        {
          id: "in-progress",
          title: "In Progress",
          status: "in-progress",
          color: "#60a5fa",
        },
        { id: "done", title: "Done", status: "done", color: "#34d399" },
      ];

      expect(defaultColumns).toHaveLength(3);
      expect(defaultColumns[0].id).toBe("todo");
      expect(defaultColumns[1].status).toBe("in-progress");
      expect(defaultColumns[2].title).toBe("Done");
    });

    it("should support columns with max items constraints", () => {
      const column = customColumns.find((c) => c.id === "active");
      expect(column?.maxItems).toBe(3);

      // Test max items logic simulation
      const activeItems = getColumnItems(sampleItems, "active");
      const canAddMore = !column?.maxItems ||
        activeItems.length < column.maxItems;
      expect(canAddMore).toBe(true); // No active items, so can add
    });

    it("should support column styling properties", () => {
      expect(customColumns[0].color).toBe("#6b7280");
      expect(customColumns[1].color).toBe("#3b82f6");
      expect(customColumns[2].color).toBe("#8b5cf6");
      expect(customColumns[3].color).toBe("#10b981");
    });
  });

  describe("Data Validation", () => {
    it("should handle malformed items gracefully", () => {
      const malformedItems = [
        { title: "Valid Item", status: "todo" },
        { title: "", status: "todo" }, // Empty title
        { title: "No Status Item", status: "" }, // Empty status
      ] as KanbanItem[];

      const todoItems = getColumnItems(malformedItems, "todo");
      const emptyStatusItems = getColumnItems(malformedItems, "");

      expect(todoItems).toHaveLength(2); // Two items have todo status
      expect(emptyStatusItems).toHaveLength(1); // One item has empty status
    });

    it("should maintain data integrity during operations", () => {
      const originalItem = sampleItems[0];
      const movedItems = moveItem(sampleItems, originalItem, "done");

      // Original array should remain unchanged (immutable operation)
      expect(sampleItems[0].status).toBe("todo");

      // New array should have the moved item
      const movedItem = movedItems.find((item) =>
        item.title === originalItem.title
      );
      expect(movedItem?.status).toBe("done");
    });

    it("should handle edge cases in item movement", () => {
      const emptyItems: KanbanItem[] = [];
      const resultItems = moveItem(emptyItems, sampleItems[0], "done");

      // Should return empty array when item not found
      expect(resultItems).toHaveLength(0);
    });
  });

  describe("Status Badge Logic", () => {
    it("should handle custom status badges", () => {
      const itemWithCustomBadge = sampleItems.find((item) => item.statusBadge);

      expect(itemWithCustomBadge?.statusBadge?.text).toBe("In Progress");
      expect(itemWithCustomBadge?.statusBadge?.icon).toBe("⚡");
    });

    it("should fallback to status text when no custom badge", () => {
      const itemWithoutBadge = sampleItems.find((item) => !item.statusBadge);

      expect(itemWithoutBadge?.status).toBe("todo");
      expect(itemWithoutBadge?.statusBadge).toBeUndefined();
    });

    it("should handle subtask counting", () => {
      const itemWithSubtasks = sampleItems.find((item) => item.subtaskCount);

      expect(itemWithSubtasks?.subtaskCount).toBe(3);
      expect(itemWithSubtasks?.title).toBe("Task 1");
    });
  });

  describe("Component Configuration", () => {
    it("should support different action types", () => {
      const removeAction = { type: "remove" as const };
      const editAction = { type: "edit" as const, label: "Edit Task" };
      const customAction = { type: "custom" as const, event: "custom-action" };

      expect(removeAction.type).toBe("remove");
      expect(editAction.type).toBe("edit");
      expect(editAction.label).toBe("Edit Task");
      expect(customAction.type).toBe("custom");
      expect(customAction.event).toBe("custom-action");
    });

    it("should validate column and item relationships", () => {
      // Check that sample items have statuses that match available columns
      const defaultStatuses = ["todo", "in-progress", "done"];

      for (const item of sampleItems) {
        expect(defaultStatuses).toContain(item.status);
      }
    });
  });

  describe("ct-render Integration", () => {
    it("should support items with cell property for ct-render", () => {
      const mockCell = {} as Cell; // Mock cell for testing
      const itemWithCell: KanbanItem = {
        title: "Cell-based item",
        status: "todo",
        cell: mockCell,
      };

      expect(itemWithCell.cell).toBeDefined();
      expect(itemWithCell.title).toBe("Cell-based item");
      expect(itemWithCell.status).toBe("todo");
    });

    it("should support items without cell property (backward compatibility)", () => {
      const itemWithoutCell: KanbanItem = {
        title: "Plain text item",
        status: "in-progress",
      };

      expect(itemWithoutCell.cell).toBeUndefined();
      expect(itemWithoutCell.title).toBe("Plain text item");
      expect(itemWithoutCell.status).toBe("in-progress");
    });

    it("should handle mixed items with and without cells", () => {
      const mockCell = {} as Cell;
      const mixedItems: KanbanItem[] = [
        { title: "Plain item", status: "todo" },
        { title: "Cell item", status: "in-progress", cell: mockCell },
        { title: "Another plain item", status: "done" },
      ];

      expect(mixedItems[0].cell).toBeUndefined();
      expect(mixedItems[1].cell).toBeDefined();
      expect(mixedItems[2].cell).toBeUndefined();

      // All items should still have required properties
      for (const item of mixedItems) {
        expect(item.title).toBeDefined();
        expect(item.status).toBeDefined();
      }
    });
  });
});
