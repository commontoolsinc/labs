import {
  UI,
  NAME,
  lift,
  handler,
  recipe,
  fetchData,
  cell,
} from "@commontools/common-builder";
import * as z from "zod";
import { eid, schemaQuery } from "../query.js";
import { h } from "@commontools/common-html";
import {
  prepDeleteRequest,
  prepInsertRequest,
  prepUpdateRequest,
} from "../mutation.js";

const tap = lift((x) => {
  console.log(x, JSON.stringify(x, null, 2));
  return x;
});

export const schema = z.object({
  title: z.string(),
  done: z.boolean(),
});

type TodoItem = z.infer<typeof schema>;

const addToPrompt = handler<{ prompt: string }, {}>((e, state) => {
  return fetchData(
    prepInsertRequest({
      entity: {
        title: e.prompt,
        done: false,
      },
    }),
  );
});

type Message =
  | { type: "add-item"; title: string }
  | { type: "remove-item"; item: TodoItem }
  | { type: "toggle-item"; item: TodoItem }
  | { type: "rename-item"; item: TodoItem; title: string };

const createDispatch = <E, S>(fn: (e: E, s: S) => Message) =>
  handler<E, S>((e, s) => reducer({ msg: fn(e, s) }));

const reducer = ({ msg }: { msg: Message }) => {
  console.log({ msg });
  switch (msg.type) {
    case "add-item":
      return fetchData(
        prepInsertRequest({
          entity: {
            title: msg.title,
            done: false,
          },
        }),
      );
    case "remove-item":
      return fetchData(prepDeleteRequest({ entity: msg.item, schema }));
    case "toggle-item":
      return fetchData(
        prepUpdateRequest({
          eid: eid(msg.item),
          attribute: "done",
          prev: msg.item.done,
          current: !msg.item.done,
        }),
      );
    case "rename-item":
      return fetchData(
        prepUpdateRequest({
          eid: eid(msg.item),
          attribute: "title",
          prev: msg.item.title,
          current: msg.title,
        }),
      );
  }
};

const input = recipe("input", ({ value }) => {
  const onChange = handler<InputEvent, { value: string }>((e, state) => {
    state.value = (e.target as HTMLInputElement).value;
  });

  return <input value={value} oninput={onChange({ value })}></input>;
});

export const todoQuery = recipe(
  z.object({ titleInput: z.string() }).describe("todo query"),
  ({ titleInput }) => {
    const { result: items, query } = schemaQuery(schema);
    tap({ obj: items });


    const onAddItem = createDispatch<{}, { titleInput: string }>((_, state) => {
      const titleInput = state.titleInput;
      state.titleInput = "";
      return { type: "add-item", title: titleInput };
    });

    const onToggleItem = createDispatch<{}, { item: TodoItem }>(
      (_, state) => ({ type: "toggle-item", item: state.item })
    );

    const onRenameItem = createDispatch<
      { detail: { checked: boolean; value: string } },
      { item: TodoItem }
    >((e, state) => ({
      type: "rename-item",
      item: state.item,
      title: e.detail.value,
    }));

    const onDeleteItem = createDispatch<{}, { item: TodoItem }>(
      (_, state) => ({ type: "remove-item", item: state.item })
    );

    return {
      [NAME]: "Todo query",
      [UI]: (
        <div>
          <div>
            {input({ value: titleInput })}
            <button onclick={onAddItem({ titleInput })}>Add</button>
          </div>
          <ul>
            {items.map((item) => (
              <li>
                <common-hstack>
                  <common-todo
                    checked={item.done}
                    value={item.title}
                    ontodo-checked={onToggleItem({ item })}
                    ontodo-input={onRenameItem({ item })}
                  />
                  <sl-button
                    outline
                    variant="danger"
                    onclick={onDeleteItem({ item })}
                  >
                    Delete
                  </sl-button>
                </common-hstack>
              </li>
            ))}
          </ul>
        </div>
      ),
      data: items,
      query,
      addToPrompt: addToPrompt({}),
    };
  },
);
