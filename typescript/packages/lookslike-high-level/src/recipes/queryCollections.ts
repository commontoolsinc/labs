import { html } from "@commontools/common-html";
import {
  recipe,
  UI,
  llm,
  NAME,
  lift,
  handler,
  navigateTo,
  str,
  cell,
  ifElse,
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

const grabKeywords = lift<{ result?: string }, any>(({ result }) => {
  if (!result) {
    return [];
  }
  const jsonMatch = result.match(/```json\n([\s\S]+?)```/);
  if (!jsonMatch) {
    console.error("No JSON found in text:", result);
    return [];
  }
  let rawData = JSON.parse(jsonMatch[1]);
  return rawData;
});

const keywordPrompt = lift<{ search: string }>(({ search }) => {
  return {
    messages: [
      `Extract keywords from this search query: "${search}"`,
      "```json\n[",
    ],
    system: "Respond with a JSON array of keywords in a block",
    stop: "```",
  };
});

const guessShapePrompt = lift<{ search: string }>(({ search }) => {
  return {
    messages: [
      `Guess the minimal data shape for this search query: "${search}"`,
      "```json\n{",
    ],
    system:
      "Respond with a JSON object representing the likely data shape with field names as keys and expected data types as values.",
    stop: "```",
  };
});

const generateFlexibleQuery = lift(
  ({
    dataShape,
    keywords,
  }: {
    dataShape: Record<string, string>;
    keywords: string[];
  }) => {
    const select: Record<string, any> = {
      collection: "?collection",
      item: [],
    };

    const where: Array<Record<string, any>> = [
      { Case: ["?collection", "member", "?item"] },
    ];

    // Add flexible OR conditions for collection names
    if (keywords.length > 0) {
      where.push({
        Or: keywords.map((keyword) => ({
          Case: ["?collection", "name", keyword],
        })),
      });
    }

    let names: string[] = [];
    let fields: any[] = [];

    // Generate flexible conditions for each field in the data shape
    Object.entries(dataShape).forEach(([field, type]) => {
      names.push(field);

      fields.push(
        // Or: [
        { Case: ["?item", field, `?${field}`] },
        // { Case: ["?item", "has_" + field, `?${field}`] },
        // { Case: ["?item", field.toLowerCase(), `?${field}`] },
        // { Case: ["?item", field.toUpperCase(), `?${field}`] },
        // ],
      );
    });

    select.item.push(Object.fromEntries(names.map((f) => [f, `?${f}`])));
    where.push({ Or: fields });

    return {
      select,
      where,
    };
  },
);

const buildQuery = lift(({ query }) => {
  if (!query) return {};
  return {
    url: `/api/data`,
    options: {
      method: "PUT",
      body: JSON.stringify(query),
    },
  };
});

export const queryCollections = recipe<{ search: string }>(
  "Fetch Collections",
  ({ search }: { search: string }) => {
    search.setDefault("");
    const query = cell<any>({ where: [] });

    const keywords = grabKeywords(llm(keywordPrompt({ search })));
    const dataShape = grabKeywords(llm(guessShapePrompt({ search })));

    const flexibleQuery = generateFlexibleQuery({ dataShape, keywords });

    const { result } = streamData(buildQuery({ query: flexibleQuery }));

    // const collections = ensureArray({ data: collectionResults?.data });
    const data = ensureArray({ data: result });
    const normalizedData = normalizeData({ result: result });
    const exportedData = lift((data: any[]) => ({ items: data }))(
      normalizedData,
    );

    return {
      [NAME]: "Query Synopsys Collections",
      [UI]: html`<div>
        ${ifElse(
          result,
          html`<div>
            <div class="collection-input">
              <input
                value=${search}
                onkeyup=${onInput({ value: search })}
                type="text"
                placeholder="Enter search query"
              />
              <div>Keywords: ${stringify({ obj: keywords })}</div>
              <pre>${stringify({ obj: dataShape })}</pre>

              <button
                onclick=${generateQuery({
                  collectionName: search,
                  query,
                })}
              >
                Load
              </button>
            </div>

            <details open>
              <summary>Results</summary>
              <pre>${stringify({ obj: normalizedData })}</pre>
            </details>
            <details>
              <summary>Generated Query</summary>
              <pre>${stringify({ obj: flexibleQuery })}</pre>
            </details>
          </div>`,
          html`<div>Loading...</div>`,
        )}
      </div>`,
      result,
      // collections,
      data: exportedData,
    };
  },
);
