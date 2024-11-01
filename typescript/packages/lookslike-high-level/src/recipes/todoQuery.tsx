import {
  UI,
  NAME,
  lift,
  handler,
  recipe,
  fetchData,
} from "@commontools/common-builder";
import * as z from "zod";
import { eid, schemaQuery } from "../query.js";
import { h } from "@commontools/common-html";
import { prepDeleteRequest, prepInsertRequest, prepUpdateRequest } from "../mutation.js";

const tap = lift((x) => {
  console.log(x, JSON.stringify(x, null, 2));
  return x;
});

export const schema = z.object({
  title: z.string(),
  done: z.boolean(),
});

type TodoItem = z.infer<typeof schema>;

const onAddItem = handler<{}, { titleInput: string }>((_, state) => {
  const titleInput = state.titleInput;
  state.titleInput = "";
  return fetchData(
    prepInsertRequest({
      entity: {
        title: titleInput,
        done: false
      }
    }),
  );
});

const toggleItem = handler<{}, { item: TodoItem }>((e, state) => {
  const item = state.item;
  return fetchData(
    prepUpdateRequest({
      eid: eid(item),
      attribute: "done",
      prev: item.done,
      current: !item.done,
    }),
  );
});

const renameItem = handler<
  { detail: { checked: boolean; value: string } },
  { item: TodoItem }
>((e, state) => {
  const item = state.item;
  return fetchData(
    prepUpdateRequest({
      eid: eid(item),
      attribute: "title",
      prev: item.title,
      current: e.detail.value,
    }),
  );
});

const deleteItem = handler<{}, { item: TodoItem; items: TodoItem[] }>(
  (_, state) => {
    const item = state.item;
    return fetchData(
      prepDeleteRequest({ entity: item, schema }),
    );
  },
);


const addToPrompt = handler<
  { prompt: string },
  {}
>((e, state) => {
  return fetchData(
    prepInsertRequest({
      entity: {
        title: e.prompt,
        done: false
      }
    }),
  );
});

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
      addToPrompt: addToPrompt({})
    };
  },
);
