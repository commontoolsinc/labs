import { h } from "@commontools/common-html";
import {
  recipe,
  lift,
  llm,
  handler,
  NAME,
  UI,
} from "@commontools/common-builder";
import { z } from "zod";

const Prompt = z.object({
  prompt: z.string().describe("Image generation prompt"),
});
type Prompt = z.infer<typeof Prompt>;

const imageUrl = lift(
  ({ title }) => `/api/img/?prompt=${encodeURIComponent(title)}`,
);

// FIXME(ja): allowing both detail.value and newTitle is a bit of a hack
const updateTitle = handler<
  { detail: { value: string } },
  { title: string; newTitle?: string }
>(({ detail }, state) => {
  state.title = detail?.value || state.newTitle || "";
});

const grabPrompts = lift<{ result?: string }, Prompt[]>(({ result }) => {
  if (!result) {
    return [];
  }
  const jsonMatch = result.match(/```json\n([\s\S]+?)```/);
  if (!jsonMatch) {
    console.error("No JSON found in text:", result);
    return [];
  }
  let rawData = JSON.parse(jsonMatch[1]);
  let parsedData = z.array(Prompt).safeParse(rawData);
  if (!parsedData.success) {
    console.error("Invalid JSON:", parsedData.error);
    return [];
  }
  return parsedData.data;
});

const buildPrompt = lift<
  { title: string },
  { messages: string[]; system: string; stop: string } | {}
>(({ title }) => {
  if (!title) return {};

  return {
    system: `Generate 10 image prompt variations when a user sends you a prompt.
Some should change just the style, some should change the content, 
and some should change both. The last should be a completely different prompt.

<schema>
[{"prompt": "string"}, ...]
</schema>`,
    messages: [`Generate image prompt variations for: ${title}`, "```json\n["],
    stop: "\n```\n",
  };
});

const addToPrompt = handler<{ prompt: string }, { title: string }>(
  (e, state) => {
    state.title += " " + e.prompt;
  },
);

const Title = z
  .object({
    title: z
      .string()
      .describe("Image generation prompt")
      .default("abstract geometric art"),
  })
  .describe("Image generation prompt");

export const prompt = recipe(Title, ({ title }) => {
  const variations = grabPrompts(llm(buildPrompt({ title })));

  let src = imageUrl({ title });

  return {
    [NAME]: title,
    [UI]: (
      <os-container>
        <common-input
          value={title}
          placeholder="List title"
          oncommon-input={updateTitle({ title })}
        />
        <img src={src} width="512" />
        <ul>
          {variations.map((v) => (
            <img
              title={v.prompt}
              src={imageUrl({ title: v.prompt })}
              width="20%"
              onclick={updateTitle({ title, newTitle: v.prompt })}
            />
          ))}
        </ul>
      </os-container>
    ),
    title,
    variations,
    addToPrompt: addToPrompt({ title }),
  };
});
