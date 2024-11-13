import { h } from "@commontools/common-html";
import { recipe, lift, UI } from "@commontools/common-builder";
import { z } from "zod";

const compute = (fn: () => any) => lift(fn)(undefined);

export const closures = recipe(
  z
    .object({ test: z.string().default("Test string") })
    .describe("Closures experiment"),
  z.object({}),
  ({ test }) => {
    const concat = compute(() => "Hello " + test);
    const ui = compute(() => <div>{`${concat}`}!</div>);
    return { [UI]: ui };
  },
);
