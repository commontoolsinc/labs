import { html } from "@commontools/common-html";
import {
  recipe,
  fetchData,
  UI,
  NAME,
  ifElse,
} from "@commontools/common-builder";

interface Item {
  id: string;
  title: string;
}

export const fetchExample = recipe<{ url: string }>(
  "Fetch Example",
  ({ url }) => {
    const { result } = fetchData<Item[]>({
      url,
      schema: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
          },
        },
      },
    });

    return {
      [NAME]: "Fetch Example",
      [UI]: html`<div>
        ${ifElse(
          result,
          html`<div>
            ${result.map(({ title, id }) => html`<div>${title} - ${id}</div>`)}
          </div>`,
          html`<div>Loading...</div>`
        )}
      </div>`,
      result,
    };
  }
);
