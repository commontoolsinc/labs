import { h } from "@commontools/common-html";
import { recipe, NAME, UI, handler } from "@commontools/common-builder";
import { z } from "zod";

const inc = handler<{}, { count: number }>(({ }, state) => {
  state.count += 1;
});

const updateValue = handler<{ detail: { value: string } }, { value: string }>(
  ({ detail }, state) => {
    detail?.value && (state.value = detail.value);
  }
);

const Counter = z.object({
  title: z.string().default("untitled counter"),
  count: z.number().default(0)
}).describe("A counter");

export const counter = recipe(Counter, ({ title, count }) => {
  return {
    [NAME]: title,
    [UI]: <os-container>
      <common-input
        value={title}
        placeholder="Name of counter"
        oncommon-input={updateValue({ value: title })}
      />
      <p>{count}</p>
      <button onclick={inc({ count })}>Inc</button>
    </os-container>,
    count,
  };
});
