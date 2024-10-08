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
  cell,
} from "@commontools/common-builder";
import { launch } from "../data.js";
import { streamData } from "@commontools/common-builder";
import { runtimeWorkbench } from "./runtimeWorkbench.js";

const ensureArray = lift(({ data }: { data: any }) =>
  Array.isArray(data) ? data : [data],
);

const tap = lift((x) => {
  console.log(x, JSON.stringify(x, null, 2));
  return x;
});

const listCollections = JSON.stringify({
  select: {
    id: "?collection",
    name: "?name",
    item: [
      {
        id: "?item",
      },
    ],
  },
  where: [
    { Case: ["?collection", "name", "?name"] },
    { Case: ["?collection", "member", "?item"] },
  ],
});

const stringify = lift(({ obj }) => {
  console.log("stringify", obj);
  return JSON.stringify(obj || {}, null, 2);
});

const onInput = handler<KeyboardEvent, { value: string }>((input, state) => {
  state.value = (input.target as HTMLTextAreaElement).value;
});

const generateQuery = handler<
  MouseEvent,
  {
    collectionName: string;
    fields: string;
    query: string;
  }
>((event, state) => {
  const fieldList = state.fields.split(",").map((field) => field.trim());
  const query = {
    select: {
      id: "?item",
      ...fieldList.reduce(
        (acc, field) => ({ ...acc, [field]: `?${field}` }),
        {},
      ),
    },
    where: [
      { Case: ["?collection", "name", state.collectionName] },
      { Case: ["?collection", "member", "?item"] },
      ...fieldList.map((field) => ({ Case: ["?item", field, `?${field}`] })),
    ],
  };
  console.log("Generated query:", JSON.stringify(query, null, 2));
  state.query = query;
});

const onWorkbench = handler<
  MouseEvent,
  {
    data: any;
  }
>((event, state) => {
  launch(runtimeWorkbench, {
    data: state.data,
  });
});

export const queryCollections = recipe<{}>("Fetch Collections", ({}) => {
  const query = cell<any>({ where: [] });

  const { result: collectionResults } = streamData({
    url: `/api/data`,
    options: {
      method: "PUT",
      body: listCollections,
    },
  });

  const { result } = streamData({
    url: `/api/data`,
    options: {
      method: "PUT",
      body: stringify({ obj: query }),
    },
  });

  const collections = ensureArray({ data: collectionResults });
  const data = ensureArray({ data: collectionResults });
  const exportedData = lift((data: any[]) => ({ items: data }))(data);

  const collectionNameInput = cell<string>("links");
  const schemaInput = cell<string>(`title, summary, import/url, import/time`);
  // schemaInput.setDefault(`title, summary`)

  return {
    [NAME]: "Query Synopsys Collections",
    [UI]: html`<div>
      ${ifElse(
        result,
        html`<div>
          <div class="collection-list">
            ${collections.map(
              (collection) => html`
                <span class="collection-name"
                  >${collection.name} (${collection.item.length})</span
                >
              `,
            )}
          </div>
          <div class="collection-input">
            <input
              value=${collectionNameInput}
              onkeyup=${onInput({ value: collectionNameInput })}
              type="text"
              placeholder="Enter collection name"
            />
            <textarea
              value=${schemaInput}
              onkeyup=${onInput({ value: schemaInput })}
              style="width: 100%; min-height: 128px;"
            ></textarea>

            <common-button
              onclick=${generateQuery({
                collectionName: collectionNameInput,
                fields: schemaInput,
                query,
              })}
            >
              Go
            </common-button>
          </div>

          <p>Number of items: ${data.length}</p>
          <pre>${stringify({ obj: data })}</pre>
          <details>
            <summary>Generated Query</summary>
            <pre>${stringify({ obj: query })}</pre>
          </details>
          <common-button onclick=${onWorkbench({ data })}>
            Open in Workbench
          </common-button>
        </div>`,
        html`<div>Loading...</div>`,
      )}
    </div>`,
    result,
    collections,
    data: exportedData,
  };
});
