import { h } from "@commontools/common-html";
import {
  recipe,
  lift,
  llm,
  handler,
  navigateTo,
  NAME,
  UI,
} from "@commontools/common-builder";
import { z } from "zod";

const Prompt = z.object({
  prompt: z.string().describe("Image generation prompt"),
});
type Prompt = z.infer<typeof Prompt>;

const imageUrl = lift(
  ({ title }) =>
    `https://ct-img.m4ke.workers.dev/?prompt=${encodeURIComponent(title)}`
);

const launcher = handler<PointerEvent, { title: string }>((_, { title }) =>
  navigateTo(prompt({ title }))
);

const updateTitle = handler<{ detail: { value: string } }, { title: string }>(
  ({ detail }, state) => {
    state.title = detail?.value ?? "untitled";
  }
);

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
  }
);

const Title = z.object({
  title: z.string().describe("Image generation prompt").default("abstract geometric art"),
});

export const prompt = recipe(Title, ({ title }) => {
  const variations = grabPrompts(llm(buildPrompt({ title })));

  let src = imageUrl({ title });

  return {
    [NAME]: title,
    [UI]: <common-vstack gap="sm">
      <common-input
        value={title}
        placeholder="List title"
        oncommon-input={updateTitle({ title })}
      ></common-input>
      <img src={src} width="100%" />
      <ul>
        {variations.map(
          ({ prompt }) =>
            <li onclick={launcher({ title: prompt })}>{prompt}</li>
        )}
      </ul>
    </common-vstack>,
    title,
    variations,
    addToPrompt: addToPrompt({ title }),
  };
});
