import { h } from "@commontools/common-html";
import {
  recipe,
  NAME,
  UI,
  handler,
  lift,
  str,
} from "@commontools/common-builder";
import { z } from "zod";

const CounterSchema = z.object({ count: z.number().default(0) });
type Counter = z.infer<typeof CounterSchema>;

const showWow = lift(({ count }: { count: number }) => count >= 3);

const increment = handler<{}, { count: number }>(({}, state) => {
  state.count += 1;
});

export default recipe(CounterSchema, ({ count }) => {
  return {
    [NAME]: str`Counter`,
    [UI]: (
      <os-container>
        <h1 style="font-size: 48px; font-weight: bold">{count}</h1>
        <button onclick={increment({ count })}>Increment</button>
        {ifElse(showWow({ count }), <h2>WOW!</h2>, <span/>)}
      </os-container>
    ),
  };
});