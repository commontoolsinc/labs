import { h } from "@commontools/common-html";
import { recipe, NAME, UI, handler, cell, lift } from "@commontools/common-builder";
import { z } from "zod";

const update = handler<{ detail: { value: string } }, { input: string, output: string, lastEdit: number }>(
  ({ detail }, state) => {
    if (detail?.value) {
      state.input = detail.value;
      const now = Date.now();
      if (now - state.lastEdit < 500) {
        return;
      }

      state.output = detail.value;
      state.lastEdit = now;
    }
  }
);

const schema = z.object({
  input: z.string(),
  output: z.string(),
  lastEdit: z.number(),
}).describe("Throttle example");

export const throttleExample = recipe(schema,
  ({ input, output, lastEdit }) => {
    input.setDefault("");
    output.setDefault("");
    lastEdit.setDefault(Date.now());

    return {
      [NAME]: "Throttle Example",
      [UI]:
        <common-hstack>
          <common-input
            value={input}
            oncommon-input={update({ input, output, lastEdit })} />
          <pre>{output}</pre>
          <pre>{lastEdit}</pre>
        </common-hstack>
    }
  });
