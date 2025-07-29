import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type KanbanColumn, type KanbanItem } from "./ct-kanban.ts";
import { type Cell } from "@commontools/runner";

/**
 * Test suite for CTKanban component with Cell-based architecture
 * Tests Cell handling, data access, and kanban functionality
 */
describe("CTKanban Cell-based Tests", () => {
  // Mock Cell implementation for testing
  const createMockCell = (data: KanbanItem): Cell => {
    const cellData = { ...data };
    return {
      get: () => cellData,
      key: (key: string) => ({
        set: (value: any) => {
          cellData[key] = value;
        },
        get: () => cellData[key],
      }),
      // id: cellData.title || "cell",
      runtime: {} as any,
      space: {} as any,
    } as any as Cell;
  };

  const sampleCells: Cell[] = [
    createMockCell({
      title: "Task 1",
      status: "todo",
      subtaskCount: 3,
    }),
    createMockCell({
      title: "Task 2",
      status: "in-progress",
      statusBadge: { text: "In Progress", icon: "⚡" },
    }),
    createMockCell({
      title: "Task 3",
      status: "done",
      done: true,
    }),
  ];

  const customColumns: KanbanColumn[] = [
    { id: "backlog", title: "Backlog", status: "backlog", color: "#6b7280" },
    {
      id: "todo",
      title: "To Do",
      status: "todo",
      maxItems: 3,
      color: "#fbbf24",
    },
    {
      id: "in-progress",
      title: "In Progress",
      status: "in-progress",
      color: "#8b5cf6",
    },
    { id: "done", title: "Completed", status: "done", color: "#34d399" },
  ];

  describe("Cell Data Access", () => {
    it("should access cell data correctly", () => {
      const cell = sampleCells[0];
      const data = cell.get();

      expect(data.title).toBe("Task 1");
      expect(data.status).toBe("todo");
      expect(data.subtaskCount).toBe(3);
    });

    it("should filter cells by status", () => {
      const todoCells = sampleCells.filter(
        (cell) => cell.get().status === "todo",
      );
      const inProgressCells = sampleCells.filter(
        (cell) => cell.get().status === "in-progress",
      );
      const doneCells = sampleCells.filter(
        (cell) => cell.get().status === "done",
      );

      expect(todoCells).toHaveLength(1);
      expect(inProgressCells).toHaveLength(1);
      expect(doneCells).toHaveLength(1);

      expect(todoCells[0].get().title).toBe("Task 1");
      expect(inProgressCells[0].get().title).toBe("Task 2");
      expect(doneCells[0].get().title).toBe("Task 3");
    });

    it("should handle empty cell arrays", () => {
      const emptyCells: Cell[] = [];
      const filtered = emptyCells.filter(
        (cell) => cell.get().status === "todo",
      );

      expect(filtered).toHaveLength(0);
    });
  });

  describe("Cell Status Updates", () => {
    it("should update cell status", () => {
      const cell = createMockCell({
        title: "Test Task",
        status: "todo",
      });

      expect(cell.get().status).toBe("todo");

      // Update status
      cell.key("status").set("in-progress");
      expect(cell.get().status).toBe("in-progress");
    });

    it("should maintain other properties when updating status", () => {
      const cell = createMockCell({
        title: "Test Task",
        status: "todo",
        subtaskCount: 5,
        done: false,
      });

      cell.key("status").set("done");

      const data = cell.get();
      expect(data.status).toBe("done");
      expect(data.title).toBe("Test Task");
      expect(data.subtaskCount).toBe(5);
      expect(data.done).toBe(false); // Not automatically updated
    });
  });

  describe("Column Operations with Cells", () => {
    it("should group cells by column status", () => {
      const columnGroups = customColumns.map((column) => ({
        column,
        cells: sampleCells.filter(
          (cell) => cell.get().status === column.status,
        ),
      }));

      expect(columnGroups[0].cells).toHaveLength(0); // backlog
      expect(columnGroups[1].cells).toHaveLength(1); // to-do status
      expect(columnGroups[2].cells).toHaveLength(1); // in-progress
      expect(columnGroups[3].cells).toHaveLength(1); // done
    });

    it("should respect column max items constraint", () => {
      const todoColumn = customColumns.find((col) => col.status === "todo");
      const todoCells = sampleCells.filter(
        (cell) => cell.get().status === "todo",
      );

      expect(todoColumn?.maxItems).toBe(3);
      expect(todoCells.length).toBeLessThanOrEqual(todoColumn?.maxItems || 0);
    });
  });

  describe("Status Badge with Cells", () => {
    it("should access status badge from cell", () => {
      const cellWithBadge = sampleCells[1];
      const data = cellWithBadge.get();

      expect(data.statusBadge).toBeDefined();
      expect(data.statusBadge?.text).toBe("In Progress");
      expect(data.statusBadge?.icon).toBe("⚡");
    });

    it("should handle cells without status badge", () => {
      const cellWithoutBadge = sampleCells[0];
      const data = cellWithoutBadge.get();

      expect(data.statusBadge).toBeUndefined();
      expect(data.status).toBe("todo"); // Falls back to status
    });
  });

  describe("Subtask Handling with Cells", () => {
    it("should access subtask count from cell", () => {
      const cellWithSubtasks = sampleCells[0];
      const data = cellWithSubtasks.get();

      expect(data.subtaskCount).toBe(3);
    });

    it("should handle cells without subtasks", () => {
      const cellWithoutSubtasks = sampleCells[2];
      const data = cellWithoutSubtasks.get();

      expect(data.subtaskCount).toBeUndefined();
    });
  });

  describe("Cell Identity and Keys", () => {
    it("should maintain cell identity during operations", () => {
      const cell = createMockCell({
        title: "Test Task",
        status: "todo",
      });
      const originalCell = cell;

      // After getting data, cell reference should remain
      const data = cell.get();
      expect(cell).toBe(originalCell);

      // After updating, cell reference should remain
      cell.key("status").set("done");
      expect(cell).toBe(originalCell);
    });

    it("should generate unique keys for repeat directive", () => {
      const keys = sampleCells.map((cell) => {
        const data = cell.get();
        return `${data.title || "item"}-${data.status}`;
      });

      expect(keys).toEqual([
        "Task 1-todo",
        "Task 2-in-progress",
        "Task 3-done",
      ]);
      // All keys should be unique
      expect(new Set(keys).size).toBe(keys.length);
    });
  });
});
