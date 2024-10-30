import { html} from "@commontools/common-html";
import {
  UI,
  NAME,
  lift,
  handler,
} from "@commontools/common-builder";
import * as z from "zod";
import { queryRecipe } from "../query.js";

export const schema = z.object({
  title: z.string(),
  author: z.string(),
})

type Article = z.infer<typeof schema>;

export const listItems = lift(({ items } : { items: Article[] }) => {
    return html`<ul>
        ${(items || []).map(({ title, author }) => html`<li>${title} - ${author}</li>`)}
    </ul>`;
})

const onAddRandomItem = handler<{}, { items: Article[] }>((e, state) => {
  state.items.push({ title: "New article", author: "New author" });
})

export const articleQuery = queryRecipe(
  schema,
  (items) => {
    return {
      [NAME]: 'Article query',
      [UI]: html`<ul>
          ${items.map(({ title, author }) => html`<li>${title} - ${author}</li>`)}
          <li><button onclick=${onAddRandomItem({ items })}>Add</button></li>
      </ul>`,
      data: items,
    };
  },
);
