import {
  recipe,
  NAME,
  UI,
  handler,
  cell,
  lift,
} from "@commontools/common-builder";
import { z } from "zod";
import { h } from "@commontools/common-html";

const schema = z
  .object({
    prompt: z.string(),
  })
  .describe("Generative Image");

const update = handler<
  { detail: { value: string } },
  { prompt: string; debouncedPrompt: string; timeoutId: number }
>(({ detail }, state) => {
  if (detail?.value) {
    state.prompt = detail.value;

    if (state.timeoutId) {
      clearTimeout(state.timeoutId);
    }

    state.timeoutId = setTimeout(() => {
      state.debouncedPrompt = detail.value;
    }, 500) as unknown as number;
  }
});

export const generativeImage = recipe(schema, ({ prompt }) => {
  prompt.setDefault("");

  const debouncedPrompt = cell<string>("");
  const timeoutId = cell<number>(0);
  debouncedPrompt.setDefault("");
  timeoutId.setDefault(0);

  const genImageUrl = lift(
    ({ prompt }) => `/api/img/?prompt=${encodeURIComponent(prompt)}`,
  );

  return (
    <common-vstack>
      <common-input
        value={prompt}
        oncommon-input={update({ prompt, debouncedPrompt, timeoutId })}
      />
      <img src={genImageUrl({ prompt: debouncedPrompt })} />
    </common-vstack>
  );
});
