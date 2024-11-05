import { h } from "@commontools/common-html";
import {
  recipe,
  NAME,
  UI,
  handler,
  lift,
  llm,
  fetchData,
  ifElse,
} from "@commontools/common-builder";
import { z } from "zod";
import { zodSchemaQuery, eid } from "../query.js";
import {
  prepDeleteRequest,
  prepInsertRequest,
  prepUpdateRequest,
} from "../mutation.js";

const deleteItem = handler<{}, { item: Picture }>((e, state) => {
  console.log("deleteItem", state);
  return fetchData(prepDeleteRequest({ entity: state.item, schema: Picture }));
});

const add = handler<{ detail: { value: string; key: string } }, { s: string }>(
  ({ detail }, { s }) => {
    console.log("add", detail);
    if (s) {
      return fetchData(
        prepInsertRequest({
          entity: {
            prompt: s,
          },
        }),
      );
    }

    if (detail?.key !== "Enter") return;
    const prompt = detail.value;
    return fetchData(
      prepInsertRequest({
        entity: {
          prompt: prompt,
        },
      }),
    );
  },
);

const genImage = lift(
  ({ prompt }) => `/api/img/?prompt=${encodeURIComponent(prompt)}`,
);

const tap = lift((x) => {
  console.log(JSON.stringify(x, null, 2));
});

const LatentExplorer = z
  .object({
    prompts: z.array(z.string()).default([]),
  })
  .describe("Latent explorer");
type LatentExplorer = z.infer<typeof LatentExplorer>;

const Picture = z
  .object({
    prompt: z.string(),
  })
  .describe("Picture");
type Picture = z.infer<typeof Picture>;

const picture = recipe(Picture, ({ prompt, item }) => {
  return {
    [NAME]: "prompt",
    [UI]: (
      <span class="latentItem">
        <img src={genImage({ prompt: prompt })} />
        <button onclick={deleteItem({ item })}>Remove</button>
      </span>
    ),
  };
});

const prepSuggestions = lift(({ prompts }) => {
  if (!prompts) return {};
  return {
    system: `You are a manic moderator for an entertaining discussion.
        Suggest new guests to invite to the discussion based on the current guests provided by the user.  Reply with a list of names in JSON, then after the json describe why!`,
    model: "groq:llama-3.1-8b-instant",
    messages: [
      `Current guests: \n- ${prompts.map((p) => p.prompt).join("\n - ")}`,
      '```json\n{"suggestions": ["',
    ],
    stop: "\n```",
  };
});

const grabJson = lift<{ result?: string }, string[]>(({ result }) => {
  if (!result) {
    return [];
  }
  const jsonMatch = result.match(/```json\n([\s\S]+?)```/);
  if (!jsonMatch) {
    console.error("No JSON found in text:", result);
    return [];
  }
  let rawData = JSON.parse(jsonMatch[1]);
  return rawData.suggestions;
});

export const latentExplorer = recipe(LatentExplorer, ({ prompts }) => {
  const { result, query } = zodSchemaQuery(Picture);

  const suggestions = grabJson(llm(prepSuggestions({ prompts: result })));
  // tap({ result })

  return {
    [NAME]: "Latent Guests",
    [UI]: (
      <os-container>
        <style type="text/css">
          {`
                    .latentItem {
                        display: inline-block;
                        background-color: #f0f0f0;
                        margin: 2px;
                        position: relative;
                    }
                    .latentItem button {
                        display: none;
                    }
                    .latentItem img {
                        width: 192px;
                        height: 192px;
                    }
                    .latentItem:hover button {
                        display: block;
                        position: absolute;
                        top: 5px;
                        right: 5px;
                        background-color: rgba(255, 255, 255, 0.7);
                        border: none;
                        padding: 5px 10px;
                        cursor: pointer;
                    }
                  `}
        </style>
        <common-input
          placeholder="new guest"
          oncommon-keydown={add({ prompts })}
        />
        {result.map((item) => picture({ prompt: item.prompt, item })[UI])}
        <ul>
          {suggestions.map((s) => (
            <li onclick={add({ prompts, s })}>{s}</li>
          ))}
        </ul>
      </os-container>
    ),
    query,
    data: result,
    // suggestions: { items: suggestions },
  };
});
