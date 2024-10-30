import { html} from "@commontools/common-html";
import {
  UI,
  NAME,
  lift,
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

export const articleQuery = queryRecipe(
  schema,
  (items) => {
    return {
      [NAME]: 'Article query',
      [UI]: html`<div>
        ${listItems({ items })}
      </div>`,
      data: items,
    };
  },
);
