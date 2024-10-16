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
import * as DB from "datalogia";

const ensureArray = lift(({ data }: { data: any }) => {
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
});

const stringify = lift(({ obj }) => {
  return JSON.stringify(obj, null, 2);
});

const toPairs = lift(({ obj }) => {
  return Object.entries(obj)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
});

const onInput = handler<KeyboardEvent, { value: string }>((input, state) => {
  state.value = (input.target as HTMLTextAreaElement).value;
});

const generateQuery = handler<{}, { collectionName: string; query: any }>(
  (_, state) => {
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
  },
);

const onWorkbench = handler<MouseEvent, { data: any }>((_, state) =>
  navigateTo(runtimeWorkbench({ data: state.data })),
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
    {},
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
      `Generate 5 keywords for this search query, consider fields that may appear in the resulting data: "${search}"`,
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
    query,
    keywords,
  }: {
    dataShape: Record<string, string>;
    query: string;
    keywords: string[];
  }) => {
    const select: Record<string, any> = {
      collection: "?collection",
      item: [
        {
          item: "?item",
          key: "?key",
          value: "?value",
        },
      ],
    };

    const where: Array<Record<string, any>> = [
      { Case: ["?collection", "member", "?item"] },
    ];

    if (query?.trim().split(/\s+/).length === 1) {
      keywords.push(query.trim());
    }

    // if (keywords.length > 0) {
    //   where.push({ Case: ["?item", "?key", DB.like('?value', '*' + keywords[0] + '*')] });
    // } else {
    where.push({ Case: ["?item", "?key", "?value"] });
    // }

    // Add flexible OR conditions for collection names
    if (keywords.length > 0) {
      where.push({
        Or: keywords.flatMap((keyword) => [
          {
            Case: ["?collection", "name", keyword],
          },
          {
            Case: ["?item", "?meh", keyword],
          },
          {
            Case: ["?item", keyword, "?meh"],
          },
        ]),
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

    // select.item.push(Object.fromEntries(names.map((f) => [f, `?${f}`])));
    // where.push({ Or: fields });

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

const printObjectProperties = lift(({ obj }: { obj: any }) => {
  const properties = Object.entries(JSON.parse(JSON.stringify(obj))).map(
    ([key, value]) => ({ key, value }),
  );

  return html`
    <table>
      <thead>
        <tr>
          <th>Key</th>
          <th>Value</th>
        </tr>
      </thead>
      <tbody>
        ${properties.map(
          (prop) => html`
            <tr>
              <td>${prop.key}</td>
              <td>${prop.value}</td>
            </tr>
          `,
        )}
      </tbody>
    </table>
  `;
});

const truncate = lift(({ text, length }) => {
  return text.length > length ? text.substring(0, length) + "…" : text;
});

export const search = recipe<{ search: string }>(
  "Search",
  ({ search }: { search: string }) => {
    search.setDefault("");
    const query = cell<any>({ where: [] });

    const keywords = grabKeywords(llm(keywordPrompt({ search })));
    const dataShape = grabKeywords(llm(guessShapePrompt({ search })));

    const flexibleQuery = generateFlexibleQuery({
      dataShape,
      keywords,
      query: search,
    });

    const { result } = streamData(buildQuery({ query: flexibleQuery }));

    // const collections = ensureArray({ data: collectionResults?.data });
    const data = ensureArray({ data: result });
    const normalizedData = normalizeData({ result: result });
    const exportedData = lift((data: any[]) => ({ items: data }))(
      normalizedData,
    );

    const entries = lift(({ data }) =>
      data.map((r) => ({ row: Object.entries(r).map(([k, v]) => ({ k, v })) })),
    )({
      data: normalizedData,
    });

    return {
      [NAME]: search,
      [UI]: html`<div>
        ${ifElse(
          result,
          html`<div>
            <os-container>
              <os-colgrid>
                ${entries.map(({ row }) => {
                  return html`<os-tile style="aspect-ratio: 1/1;">
                    <div
                      style="width: 100%; height: 100%; overflow-y: auto; overflow-x: hidden; border-radius: 2px; padding: 8px; font-size: 0.8rem;  font-family: monospace;"
                    >
                      ${row.map(
                        ({ k, v }) =>
                          html`<div style="">
                            <div
                              style="font-weight: bold; color: #999; font-size: 0.6rem; height: 16px;"
                            >
                              ${truncate({ text: k, length: 32 })}
                            </div>
                            <div style="padding: 2px;">
                              ${truncate({ text: v, length: 24 })}
                            </div>
                          </div>`,
                      )}
                    </div>
                  </os-tile>`;
                })}
              </os-colgrid>
            </os-container>
          </div>`,
          html`<div>Loading...</div>`,
        )}
      </div>`,
      result,
      // collections,
      data: exportedData,
      query: flexibleQuery,
    };
  },
);
