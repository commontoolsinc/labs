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
  cell,
} from "@commontools/common-builder";
import { z } from "zod";
import { zodSchemaQuery, eid } from "../query.js";
import {
  prepDeleteRequest,
  prepInsertRequest,
  prepUpdateRequest,
} from "../mutation.js";
import { chat } from "./chatty.js";

const ask = handler<
  { detail: { value: string; key: string } },
  { question: string; questionUI: string }
>(({ detail }, state) => {
  console.log("add", detail);
  state.questionUI = detail.value;
  if (detail?.key !== "Enter") return;
  state.question = detail.value;
});
const askSuggestion = handler<
  {},
  { s: string; question: string; questionUI: string }
>(({ detail }, state) => {
  state.question = state.s;
  state.questionUI = state.s;
});

const tap = lift((x) => {
  console.log(JSON.stringify(x, null, 2));
});

const LatentChat = z
  .object({
    prompts: z.array(z.string()).default([]),
  })
  .describe("Latent chat");
type LatentChat = z.infer<typeof LatentChat>;

const Picture = z
  .object({
    prompt: z.string(),
    // created: z.date().optional()
  })
  .describe("Picture");
type Picture = z.infer<typeof Picture>;

const prepSuggestions = lift(({ prompts, question }) => {
  console.log("suggestions", prompts, question);
  if (!prompts || !question) return {};

  return {
    system: `You are a manic moderator for a discussion between ${prompts.join(", ")}.
        Suggest follow up questions to the questions that are sent.  Take into account the current guests and the topic... But some questions should be just crazy!`,
    model: "groq:llama-3.1-8b-instant",
    messages: [question, '```json\n{"questions": ["'],
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
  return rawData.questions;
});

export const latentChat = recipe(LatentChat, ({ prompts }) => {
  const questionUI = cell("");
  const question = cell("");

  const { result, query } = zodSchemaQuery(Picture);
  const suggestions = grabJson(llm(prepSuggestions({ prompts, question })));

  tap({ result });
  tap({ suggestions });

  return {
    [NAME]: "Latent Chat",
    [UI]: (
      <os-container>
        <style type="text/css">
          {`
                    .latentItem {
                        display: inline-block;
                        background-color: #f0f0f0;
                        margin: 10px;
                        position: relative;
                    }
                  `}
        </style>
        <common-input
          placeholder="your question"
          value={questionUI}
          oncommon-keydown={ask({ questionUI, question })}
        />
        {result.map((item) => chat({ prompt: item.prompt, question })[UI])}
        <ul>
          {suggestions.map((s) => (
            <li onclick={askSuggestion({ questionUI, s, question })}>{s}</li>
          ))}
        </ul>
      </os-container>
    ),
    query,
    data: result,
  };
});
