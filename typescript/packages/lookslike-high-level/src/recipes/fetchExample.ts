import { html } from "@commontools/common-html";
import { recipe, fetchData, UI, NAME, ifElse } from "@commontools/common-builder";

interface Item {
  id: string;
  prompt: string;
}

export const fetchExample = recipe<{ url: string }>("Fetch Example", ({ url }) => {
  const { result } = fetchData<Item[]>({
    url,
    schema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          prompt: { type: "string" },
        },
      },
    },
  });

  return {
    [NAME]: "Fetch Example",
    [UI]: html`<div>
      ${ifElse(
        result,
        html`<div>${
            result.map(({ prompt, id }) => html`<div>${prompt} - ${id}</div>`)
        }</div>`,
        html`<div>Loading...</div>`,
      )}</div>`,
    result,
  };

} );
