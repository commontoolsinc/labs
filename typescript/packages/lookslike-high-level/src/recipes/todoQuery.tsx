import {
  UI,
  NAME,
  lift,
  handler,
  recipe,
  fetchData,
} from "@commontools/common-builder";
import * as z from "zod";
import { buildTransactionRequest, eid, schemaQuery } from "../query.js";
import { h } from "@commontools/common-html";
import { prepDelete, prepInsert, prepUpdate } from "../mutatation.js";

export const schema = z.object({
  title: z.string(),
  done: z.boolean(),
});

type TodoItem = z.infer<typeof schema>;

const onAddItem = handler<{}, { titleInput: string }>((e, state) => {
  const titleInput = state.titleInput;
  state.titleInput = "";
  return fetchData(
    buildTransactionRequest(
      prepInsert({
        entity: {
          title: titleInput,
          done: false
        }
      }),
    ),
  );
});

const tap = lift((x) => {
  console.log(x, JSON.stringify(x, null, 2));
  return x;
});

const toggleItem = handler<{}, { item: TodoItem }>((e, state) => {
  const item = state.item;
  return fetchData(
    buildTransactionRequest(
      prepUpdate({
        eid: eid(item),
        attribute: "done",
        prev: item.done,
        current: !item.done,
      }),
    ),
  );
});

const renameItem = handler<
  { detail: { checked: boolean; value: string } },
  { item: TodoItem }
>((e, state) => {
  const item = state.item;
  return fetchData(
    buildTransactionRequest(
      prepUpdate({
        eid: eid(item),
        attribute: "title",
        prev: item.title,
        current: e.detail.value,
      }),
    ),
  );
});

const deleteItem = handler<{}, { item: TodoItem; items: TodoItem[] }>(
  (e, state) => {
    const item = state.item;
    return fetchData(
      buildTransactionRequest(prepDelete({ entity: item, schema })),
    );
  },
);

export const todoQuery = recipe(
  z.object({ titleInput: z.string() }).describe("todo query"),
  ({ titleInput }) => {
    const { result: items, query } = schemaQuery(schema);
    tap({ obj: items });

    const onChange = handler<InputEvent, { titleInput: string }>((e, state) => {
      state.titleInput = (e.target as HTMLInputElement).value;
    });

    return {
      [NAME]: "Todo query",
      [UI]: (
        <div>
          <div>
            <input
              value={titleInput}
              placeholder="Todo title"
              oninput={onChange({ titleInput })}
            ></input>
            <button onclick={onAddItem({ titleInput })}>Add</button>
          </div>
          <ul>
            {items.map((item) => (
              <li>
                <common-hstack>
                  <common-todo
                    checked={item.done}
                    value={item.title}
                    ontodo-checked={toggleItem({ item })}
                    ontodo-input={renameItem({ item })}
                  />
                  <sl-button
                    outline
                    variant="danger"
                    onclick={deleteItem({ item, items })}
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
    };
  },
);
