import { html} from "@commontools/common-html";
import {
  UI,
  NAME,
  lift,
  handler,
  recipe,
} from "@commontools/common-builder";
import * as z from "zod";
import { queryRecipe, querySynopsys } from "../query.js";

export const schema = z.object({
  title: z.string(),
  author: z.string(),
  tags: z.array(z.string()),
})

type Article = z.infer<typeof schema>;

export const listItems = lift(({ items } : { items: Article[] }) => {
    return html`<ul>
        ${(items || []).map(({ title, author }) => html`<li>${title} - ${author}</li>`)}
    </ul>`;
})

const onAddRandomItem = handler<{}, { items: Article[] }>((e, state) => {
  state.items.push({ title: "New article", author: "New author", tags: [] });

  // post to synopsys here
})

const tap = lift((x) => {
  console.log(x, JSON.stringify(x, null, 2));
  return x;
});

export const articleQuery = recipe(
  z.object({}),
  ({ }) => {
    const items = querySynopsys(schema)
    tap({ obj: items })

    return {
      [NAME]: 'Article query',
      [UI]: html`<ul>
          ${items.map(({ title, author, tags }) => html`<li>
            ${title} - ${author}
            <ul>
              ${tags.map(tag => html`<li>${tag}</li>`)}
            </ul>
          </li>`)}
          <li><button onclick=${onAddRandomItem({ items })}>Add</button></li>
      </ul>`,
      data: items,
    };
  },
);
