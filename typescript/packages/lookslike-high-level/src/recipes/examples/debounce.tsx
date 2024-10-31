import { h } from "@commontools/common-html";
import { recipe, NAME, UI, handler } from "@commontools/common-builder";
import { z } from "zod";

const update = handler<{ detail: { value: string } }, { input: string, output: string, timeoutId: number }>(
  ({ detail }, state) => {
    if (detail?.value) {
      state.input = detail.value;

      if (state.timeoutId) {
        clearTimeout(state.timeoutId);
      }

      state.timeoutId = setTimeout(() => {
        state.output = detail.value;
      }, 500) as unknown as number;
    }
  }
);

const schema = z.object({
  input: z.string(),
  output: z.string(),
  timeoutId: z.number(),
}).describe("Debounce example");

export const debounceExample = recipe(schema,
  ({ input, output, timeoutId }) => {
    input.setDefault("");
    output.setDefault("");
    timeoutId.setDefault(0);

    return {
      [NAME]: "Debounce Example",
      [UI]:
        <common-hstack>
          <common-input
            value={input}
            oncommon-input={update({ input, output, timeoutId })} />
          <pre>{output}</pre>
          <pre>{timeoutId}</pre>
        </common-hstack>
    }
  });
