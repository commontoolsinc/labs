import {
  UI,
  NAME,
  lift,
  handler,
  recipe,
  fetchData,
  str
} from "@commontools/common-builder";
import * as z from "zod";
import { buildTransactionRequest, schemaQuery } from "../query.js";
import { h } from "@commontools/common-html";

export const schema = z.object({
  title: z.string(),
  author: z.string()
}).describe('Bookshelf');

type Book = z.infer<typeof schema>;

const eid = (e: any) => (e as any)['.'];

const onAddItem = handler<{}, { titleInput: string, authorInput : string }>((_, state) => {
  const titleInput = state.titleInput;
  const authorInput = state.authorInput;
  state.titleInput = '';
  state.authorInput = '';
  return fetchData(buildTransactionRequest(prepChanges({ title: titleInput, author: authorInput })));
})

const tap = lift((x) => {
  console.log(x, JSON.stringify(x, null, 2));
  return x;
});

const prepChanges = lift(({ title, author }) => {
  return {
    changes: [
      {
        Import: {
          title,
          author
        }
      }
    ]
  }
})

const prepRenameTitle = lift(({ prevTitle, title, id }) => {
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

const prepRenameAuthor = lift(({ prevAuthor, author, id }) => {
  return {
    changes: [
      {
        Retract: [id, 'author', prevAuthor]
      },
      {
        Assert: [id, 'author', author]
      }
    ]
  }
})

const renameTitle = handler<{ detail: { value: string } }, { item: Book }>((e, state) => {
  const item = state.item;
  return fetchData(buildTransactionRequest(prepRenameTitle({ title: e.detail.value, prevTitle: item.title, id: eid(item) })));
})

const renameAuthor = handler<{ detail: { value: string } }, { item: Book }>((e, state) => {
  const item = state.item;
  return fetchData(buildTransactionRequest(prepRenameAuthor({ author: e.detail.value, prevAuthor: item.author, id: eid(item) })));
})

const deleteItem = handler<{}, { item: Book; items: Book[] }>((_, state) => {
  const item = state.item;
  return fetchData(buildTransactionRequest({
    changes: [
      {
        Retract: [eid(item), "title", item.title],
      },
      {
        Retract: [eid(item), "author", item.author],
      }
    ]
  }));
})

const imageUrl = lift(({ title }) => `/api/img/?prompt=${encodeURIComponent(title)}`);

export const bookshelfQuery = recipe(
  z.object({ titleInput: z.string().default(''), authorInput: z.string().default('') }),
  ({ titleInput, authorInput }) => {
    const { result: items, query } = schemaQuery(schema)
    tap({ obj: items })

    const onChangeTitle = handler<InputEvent, { titleInput: string }>((e, state) => {
      state.titleInput = (e.target as HTMLInputElement).value;
    });

    const onChangeAuthor = handler<InputEvent, { authorInput: string }>((e, state) => {
      state.authorInput = (e.target as HTMLInputElement).value;
    });

    return {
      [NAME]: "Bookshelf",
      [UI]: <div>
        <div>
          <input value={titleInput} placeholder="Title" oninput={onChangeTitle({ titleInput })}></input>
          <input value={authorInput} placeholder="Author" oninput={onChangeAuthor({ authorInput })}></input>
          <button onclick={onAddItem({ titleInput, authorInput })}>Add</button></div>
        <ul>
          {items.map((item) => <li>
            <common-hstack>
              <common-input
                value={item.title}
                placeholder="Title"
                oncommon-input={renameTitle({ item })}></common-input>
              <common-input
                value={item.author}
                placeholder="Author"
                oncommon-input={renameAuthor({ item })}></common-input>
              <common-img
                src={imageUrl({title: str`Book cover of: ${item.title}`})}
                alt={item.title}></common-img>
              <sl-button outline variant="danger" onclick={deleteItem({ item, items })}>Delete</sl-button>
            </common-hstack>
          </li>)}
        </ul></div>,
      data: items,
      query
    };
  },
);
