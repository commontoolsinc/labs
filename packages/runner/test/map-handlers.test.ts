import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { spy } from "@std/testing/mock";
import "@commontools/utils/equal-ignoring-symbols";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { type JSONSchema } from "../src/builder/types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import { type ErrorWithContext } from "../src/scheduler.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { popFrame, pushFrameFromCause } from "../src/builder/pattern.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("map should not accidentally call handlers", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commontools"]["pattern"];
  let handler: ReturnType<typeof createBuilder>["commontools"]["handler"];
  const errors: ErrorWithContext[] = [];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    runtime.scheduler.onError((e) => errors.push(e));
    errors.length = 0;

    tx = runtime.edit();

    const { commontools } = createBuilder();
    ({ pattern, handler } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  type Todo = { id: string; text: string; done: boolean };
  type Edit = { type: string; id: string };

  const TodoSchema = {
    type: "object",
    properties: {
      id: { type: "string" },
      text: { type: "string" },
      done: { type: "boolean" },
    },
    required: ["id", "text", "done"],
  } as const satisfies JSONSchema;

  /**
   * Helper: simulate the daemon's write path.
   * Uses pushFrameFromCause with inHandler: true and writes cell
   * references (via getCell) into the todos array, matching how
   * the real fs-sync daemon uses Cell.of(id).set(value).
   */
  async function daemonWrite(
    todosCell: ReturnType<typeof runtime.getCell>,
    editsCell: ReturnType<typeof runtime.getCell>,
    todos: Todo[],
    edits: Edit[],
  ) {
    // Wait for any prior work to settle, like the real daemon does
    await runtime.idle();

    const dtx = runtime.edit();
    pushFrameFromCause("daemon-sync", {
      runtime,
      tx: dtx,
      space,
      inHandler: true,
    });

    try {
      // Build cell references like the real daemon: Cell.of(todo.id).set({...})
      const todoCells = todos.map((todo) => {
        const cell = runtime.getCell(space, `todo-${todo.id}`);
        cell.withTx(dtx).set(todo);
        return cell;
      });
      todosCell.withTx(dtx).set(todoCells);
      editsCell.withTx(dtx).set(edits);
    } finally {
      popFrame();
    }

    await dtx.commit();
    await runtime.idle();
  }

  // Reproduces the pattern from the fs-sync todo list:
  //   deletes: todos.map((todo) => onDelete({ todo, todos, edits }))
  // The CTS transformer converts this to mapWithPattern, passing
  // outer-scope captures (todos, edits) as params. The daemon writes
  // to input cells using pushFrameFromCause + Cell.of()-style cells.
  it("handler mapped over array should not fire when daemon writes to input cells", async () => {
    const handlerCalls: any[] = [];
    const queueEventSpy = spy(runtime.scheduler, "queueEvent");

    const onDelete = handler<
      unknown,
      { todo: Todo; todos: Todo[]; edits: Edit[] }
    >(
      { type: "object" } as const satisfies JSONSchema,
      {
        type: "object",
        properties: {
          todo: TodoSchema,
          todos: { type: "array", items: TodoSchema, asCell: true },
          edits: { type: "array", asCell: true },
        },
        required: ["todo", "todos", "edits"],
      } as const satisfies JSONSchema,
      (_event, { todo }) => {
        handlerCalls.push({ action: "delete", id: todo.id });
      },
    );

    // Inner pattern for map — replicates what CTS transformer produces.
    const mapInnerPattern = pattern(
      ({
        element: todo,
        params: { todos, edits },
      }: any) => onDelete({ todo, todos, edits }),
      {
        type: "object",
        properties: {
          element: TodoSchema,
          params: {
            type: "object",
            properties: {
              todos: { type: "array", items: TodoSchema, asCell: true },
              edits: { type: "array", asCell: true },
            },
            required: ["todos", "edits"],
          },
        },
        required: ["element", "params"],
      } as const satisfies JSONSchema,
    );

    const testPattern = pattern<{
      todos: Todo[];
      edits: Edit[];
    }>(
      ({ todos, edits }) => {
        const deletes = (todos as any).mapWithPattern(mapInnerPattern, {
          todos,
          edits,
        });
        return { todos, edits, deletes };
      },
    );

    // Create input cells
    const todosCell = runtime.getCell<Todo[]>(space, "input-todos");
    const editsCell = runtime.getCell<Edit[]>(space, "input-edits");

    // Initial state: set up like the daemon would
    const initialTodos: Todo[] = [
      { id: "1", text: "first", done: false },
      { id: "2", text: "second", done: false },
      { id: "3", text: "third", done: true },
    ];
    const initialTodoCells = initialTodos.map((todo) => {
      const cell = runtime.getCell(space, `todo-${todo.id}`);
      cell.withTx(tx).set(todo);
      return cell;
    });
    todosCell.withTx(tx).set(initialTodoCells as any);
    editsCell.withTx(tx).set([]);

    const resultCell = runtime.getCell<{
      todos: Todo[];
      edits: Edit[];
      deletes: any[];
    }>(
      space,
      "map-handlers-daemon",
      undefined,
      tx,
    );

    const result = runtime.run(tx, testPattern, {
      todos: todosCell,
      edits: editsCell,
    }, resultCell);
    tx.commit();

    await result.pull();

    expect(handlerCalls).toEqual([]);
    expect(queueEventSpy.calls.length).toBe(0);
    expect(errors).toEqual([]);
    expect(result.key("deletes").get()).toHaveLength(3);

    // --- Daemon removes todo "2" and records the edit ---
    daemonWrite(
      todosCell,
      editsCell,
      [
        { id: "1", text: "first", done: false },
        { id: "3", text: "third", done: true },
      ],
      [{ type: "delete", id: "2" }],
    );
    await result.pull();

    expect(result.key("deletes").get()).toHaveLength(2);
    expect(handlerCalls).toEqual([]);
    expect(queueEventSpy.calls.length).toBe(0);
    expect(errors).toEqual([]);

    // --- Daemon adds a new todo ---
    daemonWrite(
      todosCell,
      editsCell,
      [
        { id: "1", text: "first", done: false },
        { id: "3", text: "third", done: true },
        { id: "4", text: "fourth", done: false },
      ],
      [],
    );
    await result.pull();

    expect(result.key("deletes").get()).toHaveLength(3);
    expect(handlerCalls).toEqual([]);
    expect(queueEventSpy.calls.length).toBe(0);
    expect(errors).toEqual([]);

    // --- Daemon toggles a todo ---
    daemonWrite(
      todosCell,
      editsCell,
      [
        { id: "1", text: "first", done: true },
        { id: "3", text: "third", done: true },
        { id: "4", text: "fourth", done: false },
      ],
      [],
    );
    await result.pull();

    expect(handlerCalls).toEqual([]);
    expect(queueEventSpy.calls.length).toBe(0);
    expect(errors).toEqual([]);

    // --- Daemon replaces all todos + clears edits ---
    daemonWrite(
      todosCell,
      editsCell,
      [
        { id: "10", text: "fresh-a", done: false },
        { id: "11", text: "fresh-b", done: false },
      ],
      [],
    );
    await result.pull();

    expect(result.key("deletes").get()).toHaveLength(2);
    expect(handlerCalls).toEqual([]);
    expect(queueEventSpy.calls.length).toBe(0);
    expect(errors).toEqual([]);

    // --- Empty the array ---
    daemonWrite(todosCell, editsCell, [], []);
    await result.pull();

    expect(result.key("deletes").get()).toHaveLength(0);
    expect(handlerCalls).toEqual([]);
    expect(queueEventSpy.calls.length).toBe(0);
    expect(errors).toEqual([]);
  });

  // Run the same pattern through the CTS compiler pipeline to test
  // that the transformer output doesn't accidentally trigger handlers.
  it("CTS-compiled pattern: map of handlers should not fire on input cell changes", async () => {
    // Minimal pattern source that maps handlers over an array.
    // CTS will transform todos.map() into mapWithPattern with closure params.
    const patternSource = `/// <cts-enable />
import { handler, pattern, Writable } from "commontools";

interface Todo { id: string; text: string; done: boolean }
interface Edit { type: string; id: string }

const onDelete = handler<
  unknown,
  { todo: Todo; todos: Writable<Todo[]>; edits: Writable<Edit[]> }
>((_event, { todo, todos, edits }) => {
  // Side effect: remove from list, enqueue edit
  todos.remove(todo);
  edits.push({ type: "delete", id: todo.id });
});

export default pattern<{
  todos: Writable<Todo[]>;
  edits: Writable<Edit[]>;
}>(({ todos, edits }) => {
  const deletes = todos.map((todo) => onDelete({ todo, todos, edits }));
  return { todos, edits, deletes };
});
`;

    let compiledPattern;
    try {
      compiledPattern = await runtime.patternManager.compilePattern(
        patternSource,
      );
    } catch (e) {
      // If compilation infra isn't available in unit tests, skip
      console.log("Skipping CTS test: compiler not available", e);
      return;
    }

    const queueEventSpy = spy(runtime.scheduler, "queueEvent");

    const todosCell = runtime.getCell<Todo[]>(space, "cts-input-todos");
    const editsCell = runtime.getCell<Edit[]>(space, "cts-input-edits");

    const initialTodos: Todo[] = [
      { id: "1", text: "first", done: false },
      { id: "2", text: "second", done: false },
      { id: "3", text: "third", done: true },
    ];
    const initialTodoCells = initialTodos.map((todo) => {
      const cell = runtime.getCell(space, `cts-todo-${todo.id}`);
      cell.withTx(tx).set(todo);
      return cell;
    });
    todosCell.withTx(tx).set(initialTodoCells as any);
    editsCell.withTx(tx).set([]);

    const resultCell = runtime.getCell<{
      todos: Todo[];
      edits: Edit[];
      deletes: any[];
    }>(
      space,
      "cts-map-handlers",
      undefined,
      tx,
    );

    const result = runtime.run(tx, compiledPattern, {
      todos: todosCell,
      edits: editsCell,
    }, resultCell);
    tx.commit();

    await result.pull();

    expect(queueEventSpy.calls.length).toBe(0);
    expect(errors).toEqual([]);
    expect(result.key("deletes").get()).toHaveLength(3);

    // --- Daemon removes todo "2" ---
    daemonWrite(
      todosCell,
      editsCell,
      [
        { id: "1", text: "first", done: false },
        { id: "3", text: "third", done: true },
      ],
      [{ type: "delete", id: "2" }],
    );
    await result.pull();

    expect(result.key("deletes").get()).toHaveLength(2);
    expect(queueEventSpy.calls.length).toBe(0);
    expect(errors).toEqual([]);

    // --- Daemon adds new todo ---
    daemonWrite(
      todosCell,
      editsCell,
      [
        { id: "1", text: "first", done: false },
        { id: "3", text: "third", done: true },
        { id: "4", text: "fourth", done: false },
      ],
      [],
    );
    await result.pull();

    expect(result.key("deletes").get()).toHaveLength(3);
    expect(queueEventSpy.calls.length).toBe(0);
    expect(errors).toEqual([]);

    // --- Daemon replaces all + clears edits ---
    daemonWrite(
      todosCell,
      editsCell,
      [
        { id: "10", text: "fresh-a", done: false },
        { id: "11", text: "fresh-b", done: false },
      ],
      [],
    );
    await result.pull();

    expect(result.key("deletes").get()).toHaveLength(2);
    expect(queueEventSpy.calls.length).toBe(0);
    expect(errors).toEqual([]);
  });

  it("sanity check: explicitly sending to a mapped handler stream does invoke it", async () => {
    const handlerCalls: any[] = [];

    const onDelete = handler<
      unknown,
      { todo: Todo; todos: Todo[]; edits: Edit[] }
    >(
      { type: "object" } as const satisfies JSONSchema,
      {
        type: "object",
        properties: {
          todo: TodoSchema,
          todos: { type: "array", items: TodoSchema, asCell: true },
          edits: { type: "array", asCell: true },
        },
        required: ["todo", "todos", "edits"],
      } as const satisfies JSONSchema,
      (_event, { todo }) => {
        handlerCalls.push({ action: "delete", id: todo.id });
      },
    );

    const mapInnerPattern = pattern(
      ({
        element: todo,
        params: { todos, edits },
      }: any) => onDelete({ todo, todos, edits }),
      {
        type: "object",
        properties: {
          element: TodoSchema,
          params: {
            type: "object",
            properties: {
              todos: { type: "array", items: TodoSchema, asCell: true },
              edits: { type: "array", asCell: true },
            },
            required: ["todos", "edits"],
          },
        },
        required: ["element", "params"],
      } as const satisfies JSONSchema,
    );

    const testPattern = pattern<{ todos: Todo[]; edits: Edit[] }>(
      ({ todos, edits }) => {
        const deletes = (todos as any).mapWithPattern(mapInnerPattern, {
          todos,
          edits,
        });
        return { todos, edits, deletes };
      },
    );

    const todosCell = runtime.getCell<Todo[]>(space, "sanity-todos");
    todosCell.withTx(tx).set([
      { id: "1", text: "first", done: false },
      { id: "2", text: "second", done: false },
    ]);

    const editsCell = runtime.getCell<Edit[]>(space, "sanity-edits");
    editsCell.withTx(tx).set([]);

    const resultCell = runtime.getCell<{
      todos: Todo[];
      edits: Edit[];
      deletes: any[];
    }>(
      space,
      "map-handlers-sanity",
      undefined,
      tx,
    );

    const result = runtime.run(tx, testPattern, {
      todos: todosCell,
      edits: editsCell,
    }, resultCell);
    tx.commit();

    await result.pull();
    expect(handlerCalls).toEqual([]);

    // Explicitly send to the first delete handler — this SHOULD invoke it
    const deletes = result.key("deletes").get();
    deletes[0].send({});
    await result.pull();

    expect(handlerCalls).toEqual([{ action: "delete", id: "1" }]);
  });
});
