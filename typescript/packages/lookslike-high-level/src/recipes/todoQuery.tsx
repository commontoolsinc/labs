import {
  UI,
  NAME,
  lift,
  handler,
  recipe,
  fetchData,
} from "@commontools/common-builder";
import * as z from "zod";
import { buildTransactionRequest, schemaQuery } from "../query.js";
import { h } from "@commontools/common-html";

export const schema = z.object({
  title: z.string(),
  done: z.boolean(),
})

type TodoItem = z.infer<typeof schema>;

const eid = (e: any) => (e as any)['.'];

const onAddItem = handler<{}, { titleInput: string }>((e, state) => {
  const titleInput = state.titleInput;
  state.titleInput = '';
  return fetchData(buildTransactionRequest(prepChanges({ title: titleInput, done: false })));
})

const tap = lift((x) => {
  console.log(x, JSON.stringify(x, null, 2));
  return x;
});

const prepChanges = lift(({ title, done }) => {
  return {
    changes: [
      {
        Import: {
          title,
          done
        }
      }
    ]
  }
})

const prepToggle = lift(({ done, id }) => {
  return {
    changes: [
      {
        Retract: [id, 'done', done]
      },
      {
        Assert: [id, 'done', !done]
      }
    ]
  }
})


const prepRename = lift(({ prevTitle, title, id }) => {
  return {
    changes: [
      {
        Retract: [id, 'title', prevTitle]
      },
      {
        Assert: [id, 'title', title]
      }
    ]
  }
})

const toggleItem = handler<{}, { item: TodoItem }>((e, state) => {
  const item = state.item;
  return fetchData(buildTransactionRequest(prepToggle({ done: item.done, id: eid(item) })));
})

const renameItem = handler<{ detail: { checked: boolean; value: string } }, { item: TodoItem }>((e, state) => {
  const item = state.item;
  return fetchData(buildTransactionRequest(prepRename({ title: e.detail.value, prevTitle: item.title, id: eid(item) })));
})

const deleteItem = handler<{}, { item: TodoItem; items: TodoItem[] }>((e, state) => {
  const item = state.item;
  return fetchData(buildTransactionRequest({
    changes: [
      {
        Retract: [eid(item), "title", item.title],
      },
      {
        Retract: [eid(item), "done", item.done],
      }
    ]
  }));
})

export const todoQuery = recipe(
  z.object({ titleInput: z.string() }).describe("todo query"),
  ({ titleInput }) => {
    const { result: items, query } = schemaQuery(schema)
    tap({ obj: items })

    const onChange = handler<InputEvent, { titleInput: string }>((e, state) => {
      state.titleInput = (e.target as HTMLInputElement).value;
    });

    return {
      [NAME]: 'Todo query',
      [UI]: <div>
        <div>
          <input value={titleInput} placeholder="Todo title" oninput={onChange({ titleInput })}></input>
          <button onclick={onAddItem({ titleInput })}>Add</button></div>
        <ul>
          {items.map((item) => <li>
            <common-hstack>
              <common-todo
                checked={item.done}
                value={item.title}
                ontodo-checked={toggleItem({ item })}
                ontodo-input={renameItem({ item })}
              />
              <sl-button outline variant="danger" onclick={deleteItem({ item, items })}>Delete</sl-button>
            </common-hstack>
          </li>)}
        </ul></div>,
      data: items,
      query
    };
  },
);
