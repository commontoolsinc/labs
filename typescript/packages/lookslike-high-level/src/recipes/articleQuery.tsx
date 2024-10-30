import { html } from "@commontools/common-html";
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
import { buildTransactionRequest, queryRecipe, querySynopsys } from "../query.js";
import { h } from "@commontools/common-html";

export const schema = z.object({
  title: z.string(),
  author: z.string(),
  tags: z.array(z.string()),
})

type Article = z.infer<typeof schema>;

export const listItems = lift(({ items }: { items: Article[] }) => {
  return html`<ul>
        ${(items || []).map(({ title, author }) => html`<li>${title} - ${author}</li>`)}
    </ul>`;
})

const onAddItem = handler<{}, { input: string }>((e, state) => {
  const input = state.input;
  state.input = ''
  return fetchData(buildTransactionRequest(prepChanges({ input })));
})

const tap = lift((x) => {
  console.log(x, JSON.stringify(x, null, 2));
  return x;
});

const prepChanges = lift(({ input }) => {
  return {
    changes: [
      {
        Import: {
          title: input,
          author: "New author",
          tags: ["tag1"]
        }
      }
    ]
  }
})

export const articleQuery = recipe(
  z.object({ input: z.string() }),
  ({ input }) => {
    const { result: items, query } = querySynopsys(schema)
    tap({ obj: items })

    const onChange = handler<InputEvent, { input: string }>((e, state) => {
      state.input = (e.target as HTMLInputElement).value;
    });

    return {
      [NAME]: 'Article query',
      [UI]: <div>
        <div>
          <input value={input} placeholder="Article title" oninput={onChange({ input })} ></input>
          <button onclick={onAddItem({ input })}>Add</button></div>
        <ul>
          {items.map(({ title, author, tags }) => <li>
            {title} - {author}
            <ul>
              {tags.map(tag => <li>{tag}</li>)}
            </ul>
          </li>)}
        </ul></div>,
      data: items,
      query
    };
  },
);
