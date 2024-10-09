import { html } from "@commontools/common-html";
import {
  recipe,
  UI,
  NAME,
  ifElse,
  lift,
  handler,
  navigateTo,
  cell,
} from "@commontools/common-builder";
import { streamData } from "@commontools/common-builder";
import { runtimeWorkbench } from "./runtimeWorkbench.js";

const ensureArray = lift(({ data }: { data: any }) =>
  Array.isArray(data) ? data : [data]
);

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
    query: any;
  }
>((_, state) => {
  const query = {
    select: {
      item: [
        {
          item: "?item",
          key: "?key",
          value: "?value",
        },
      ],
    },
    where: [
      { Case: ["?collection", "name", state.collectionName] },
      { Case: ["?collection", "member", "?item"] },
      { Case: ["?item", "?key", "?value"] },
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
>((_, state) =>
  navigateTo(
    runtimeWorkbench({
      data: state.data,
    })
  )
);

const normalizeData = lift(({ result }) => {
  if (!result || !result.data || !result.data[0] || !result.data[0].item) {
    return [];
  }
  const groupedData = result.data[0].item.reduce(
    (acc: any, { item, key, value }: any) => {
      const itemKey = item["/"];
      if (!acc[itemKey]) {
        acc[itemKey] = {};
      }
      acc[itemKey][key] = value;
      return acc;
    },
    {}
  );

  return Object.values(groupedData);
});

export const queryCollections = recipe<{}>("Fetch Collections", ({}) => {
  const query = cell<any>({ where: [] });

  // const { result: collectionResults } = streamData({
  //   url: `/api/data`,
  //   options: {
  //     method: "PUT",
  //     body: listCollections,
  //   },
  // });

  const { result } = streamData({
    url: `/api/data`,
    options: {
      method: "PUT",
      body: stringify({ obj: query }),
    },
  });

  // const collections = ensureArray({ data: collectionResults?.data });
  const data = ensureArray({ data: result });
  const normalizedData = normalizeData({ result: result });
  const exportedData = lift((data: any[]) => ({ items: data }))(data);

  const collectionNameInput = cell<string>("reminders");

  return {
    [NAME]: "Query Synopsys Collections",
    [UI]: html`<div>
      ${ifElse(
        result,
        html`<div>
          <div class="collection-input">
            <input
              value=${collectionNameInput}
              onkeyup=${onInput({ value: collectionNameInput })}
              type="text"
              placeholder="Enter collection name"
            />

            <common-button
              onclick=${generateQuery({
                collectionName: collectionNameInput,
                query,
              })}
            >
              Go
            </common-button>
          </div>

          <p>Number of items: ${data.length}</p>
          <pre>${stringify({ obj: normalizedData })}</pre>
          <details>
            <summary>Generated Query</summary>
            <pre>${stringify({ obj: query })}</pre>
          </details>
          <common-button onclick=${onWorkbench({ data })}>
            Open in Workbench
          </common-button>
        </div>`,
        html`<div>Loading...</div>`
      )}
    </div>`,
    result,
    // collections,
    data: exportedData,
  };
});
