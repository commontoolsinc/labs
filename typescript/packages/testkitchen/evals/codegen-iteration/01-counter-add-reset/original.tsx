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

const increment = handler<{}, { count: number }>(({}, state) => {
  state.count += 1;
});

export default recipe(CounterSchema, ({ count }) => {
  return {
    [NAME]: str`Counter`,
    [UI]: (
      <os-container>
        <h1>
          <strong>{count}</strong>
        </h1>
        <button onclick={increment({ count })}>Increment</button>
      </os-container>
    ),
  };
});
