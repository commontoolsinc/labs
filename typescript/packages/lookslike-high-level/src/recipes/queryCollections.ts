import { html } from "@commontools/common-html";
import {
  recipe,
  UI,
  NAME,
  lift,
  handler,
  navigateTo,
  str,
  cell,
} from "@commontools/common-builder";
import { streamData } from "@commontools/common-builder";
import { runtimeWorkbench } from "./runtimeWorkbench.js";

const ensureArray = lift(({ data }: { data: any }) => {
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
});

const stringify = lift(({ obj }) => {
  return JSON.stringify(obj, null, 2);
});

const onInput = handler<KeyboardEvent, { value: string }>((input, state) => {
  state.value = (input.target as HTMLTextAreaElement).value;
});

const generateQuery = handler<{}, { collectionName: string; query: any; }>((_, state) => {
  if (!state.collectionName) {
    state.query = undefined;
  } else {
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
    state.query = query;
  }
});

const onWorkbench = handler<MouseEvent, { data: any }>((_, state) =>
  navigateTo(runtimeWorkbench({ data: state.data })));

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

const buildQuery = lift(({ query }) => {
  if (!query) return {};
  return {
    url: `/api/data`,
    options: {
      method: "PUT",
      body: JSON.stringify(query),
      headers: {
        "content-type": "application/synopsys-query+json",
        accept: "text/event-stream",
      },
    },
  };
});

export const queryCollections = recipe<{ collectionName: string }>("Fetch Collections", ({ collectionName }) => {
  const query = cell<any>();

  collectionName.setDefault("reminders");

  // const { result: collectionResults } = streamData({
  //   url: `/api/data`,
  //   options: {
  //     method: "PUT",
  //     body: listCollections,
  //   },
  // });

  const { result } = streamData(buildQuery({ query }));

  const data = ensureArray({ data: result });
  const normalizedData = normalizeData({ result });
  const exportedData = lift((data: any[]) => ({ items: data }))(normalizedData);
  const dataSize = lift((data: any[]) => data?.length || "pending...")(normalizedData);

  return {
    [NAME]: str`Query ${collectionName}`,
    [UI]: html`<div>
          <div class="collection-input">
            <input
              value=${collectionName}
              onkeyup=${onInput({ value: collectionName })}
              type="text"
              placeholder="Enter collection name"
            />

            <common-button onclick=${generateQuery({ collectionName, query })}>
              Go
            </common-button>
          </div>

          <p>Number of items: ${dataSize}</p>
          <pre>${stringify({ obj: normalizedData })}</pre>
          <details>
            <summary>Generated Query</summary>
            <pre>${stringify({ obj: query })}</pre>
          </details>
          <common-button onclick=${onWorkbench({ data })}>
            Open in Workbench
          </common-button>
        </div>`,
    result,
    // collections,
    collectionName,
    data: exportedData,
  };
});
