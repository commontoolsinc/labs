import { html } from "@commontools/common-html";
import {
  recipe,
  fetchData,
  UI,
  NAME,
  ifElse,
  lift,
  handler,
  str,
  navigateTo,
} from "@commontools/common-builder";

interface ItemRow {
  id: string;
  title: string;
  snippet: string;
}

interface Item {
  id: number;
  url: string;
  title: string;
  content: any;
  rawContent: string;
  source: string;
  createdAt: string;
  collections: string[];
}

const asKvPairs = lift((obj: object) =>
  Object.entries(obj || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ")
);

const asTable = lift((inputData: object | object[]) => {
  const data = Array.isArray(inputData) ? inputData : [inputData];
  const headers = Array.from(
    new Set(data.flatMap((obj) => Object.keys(obj || {})))
  );

  return html`
    <table>
      <thead>
        <tr>
          ${headers.map((header) => html`<th>${header}</th>`)}
        </tr>
      </thead>
      <tbody>
        ${data.map(
          (obj) => html`
            <tr>
              ${headers.map((header) => html`<td>${obj[header] || ""}</td>`)}
            </tr>
          `
        )}
      </tbody>
    </table>
  `;
});
const collectionUrl = lift(
  (collection: string) => `/api/data/collections/${collection}/items`
);
const itemUrl = lift((id: string) => `/api/data/items/${id}`);
const viewItem = recipe<{ id: string }>("View Item", ({ id }) => {
  const { result } = fetchData<Item>({
    url: itemUrl(id),
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        snippet: { type: "string" },
      },
    },
  });

  return {
    [NAME]: str`Item: ${result.title || "(unknown)"}`,
    [UI]: html`
      <div>
        ${ifElse(
          result,
          html`
            <div>
              <h2>${result.title}</h2>
              <p>URL: ${result.url}</p>
              <p>Content Type: ${result.content.type}</p>
              <p>Content: ${result.content.content}</p>
              <p>Raw Content: ${result.rawContent}</p>
              <p>Source: ${result.source}</p>
              <p>Created At: ${result.createdAt}</p>
              <p>Item ID: ${result.id}</p>
            </div>
          `,
          html`<div>Loading...</div>`
        )}
      </div>
    `,
    result,
  };
});

const onViewItem = handler<
  {},
  {
    id: string;
  }
>((_, { id }) => {
  console.log("view item", id);
  return navigateTo(
    viewItem({
      id: id,
    })
  );
});

const viewCollecton = recipe<{ collection: string }>(
  "View Collection",
  ({ collection }) => {
    const { result } = fetchData<ItemRow[]>({
      url: collectionUrl(collection),
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
      [NAME]: str`Collection: ${collection}`,
      [UI]: html`
        <div>
          ${ifElse(
            result,
            html`
              <table>
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>snippet</th>
                    <th>id</th>
                    <th>title</th>
                  </tr>
                </thead>
                <tbody>
                  ${result.map(
                    (item) => html`
                      <tr>
                        <td>
                          <common-button onclick=${onViewItem({ id: item.id })}
                            >View Item</common-button
                          >
                        </td>
                        <td>${item.snippet || ""}</td>
                        <td>${item.id || ""}</td>
                        <td>${item.title || ""}</td>
                      </tr>
                    `
                  )}
                </tbody>
              </table>
            `,
            html`<div>Loading...</div>`
          )}
        </div>
      `,
      result,
    };
  }
);

const onViewCollection = handler<
  {},
  {
    collection: string;
  }
>((_, { collection }) => {
  // TODO: This isn't serializable. Instead we have to add a way to trigger a
  // recipe from an event.
  console.log("view collection", collection);
  return navigateTo(
    viewCollecton({
      collection: collection,
    })
  );
});

const ensureArray = lift((r: any) => (Array.isArray(r) ? r : [r]));

const tap = lift((x) => {
  console.log(x);
  return x;
});

export const fetchCollections = recipe<{ url: string }>(
  "Fetch Collections",
  ({ url }) => {
    const { result } = fetchData<any>({
      url,
    });

    const data = ensureArray(result);

    return {
      [NAME]: "Fetch Collections",
      [UI]: html`<div>
        ${ifElse(
          result,
          html`<div>
            <table>
              <thead>
                <tr>
                  <th>Action</th>
                  <th>id</th>
                  <th>name</th>
                  <th>item count</th>
                </tr>
              </thead>
              <tbody>
                ${data.map(
                  (row) => html`
                    <tr>
                      <td>
                        <common-button
                          onclick=${onViewCollection({ collection: row.name })}
                          >View</common-button
                        >
                      </td>
                      <td>${row.id || ""}</td>
                      <td>${row.name || ""}</td>
                      <td>${row.itemCount || ""}</td>
                    </tr>
                  `
                )}
              </tbody>
            </table>
          </div>`,
          html`<div>Loading...</div>`
        )}
      </div>`,
      result,
    };
  }
);
