import { html } from "@commontools/common-html";
import {
  recipe,
  UI,
  llm,
  NAME,
  lift,
  cell,
  ifElse,
} from "@commontools/common-builder";
import { streamData } from "@commontools/common-builder";

const ensureArray = lift(({ data }: { data: any }) => {
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
});

const stringify = lift(({ obj }) => {
  return JSON.stringify(obj, null, 2);
});

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
      `Generate 5 possible fields that could be on a JSON document matching this search query: "${search}"`,
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

    where.push({ Case: ["?item", "?key", "?value"] });
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
    // where.push({
    //   Match: [{ text: "?value", pattern: "email*" }, "text/like"],
    // });

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
      headers: {
        "content-type": "application/synopsys-query+json",
        accept: "text/event-stream",
      },
    },
  };
});

const truncate = lift(({ text, length }) => {
  return text.length > length ? text.substring(0, length) + "…" : text;
});

const buildTransformPrompt = lift(({ prompt, data }) => {
  let fullPrompt = prompt;
  if (data) {
    fullPrompt += `\n\nHere's the previous JSON for reference:\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  }

  return {
    messages: [fullPrompt, "```json\n"],
    system: `generate/modify a document based on input, respond within a json block , e.g.
\`\`\`json
...
\`\`\`

No field can be set to null or undefined.`,
    stop: "```",
  };
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
                      style="width: 100%; height: 100%; overflow-y: auto; box-sizing: border-box; overflow-x: hidden; border-radius: 2px; padding: 8px; font-size: 0.8rem;  font-family: monospace;"
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
