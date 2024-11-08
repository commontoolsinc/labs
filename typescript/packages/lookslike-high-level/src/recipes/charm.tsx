import { h, behavior, $, Reference, select } from "@commontools/common-system";
import { z } from "zod";
import { query } from "../sugar.jsx";

export const source = { clicker: { v: 30 } };

const init = select({ self: $.self })
  .not.match($.self, "clicks", $._)
  .assert(({ self }) => [self, "clicks", 0])
  .commit();

// const view = query(z.object({
//   id: z.object({}),
//   count: z.number(),
// }))
//   .render(({ count, self }: { count: number; self: Reference }) => {
//     return (
//       <div title={`Clicks ${count}`} entity={self}>
//         <div>{count}</div>
//         <button onclick="~/on/click">Click me!</button>
//       </div>
//     );
//   });

const view = select({ self: $.self, count: $.count })
  .match($.self, "clicks", $.count)
  .render(({ count, self }: { count: number; self: Reference }) => {
    return (
      <div title={`Clicks ${count}`} entity={self}>
        <div>{count}</div>
        <button onclick="~/on/click">Click me!</button>
      </div>
    );
  });

const onclick = select({
  self: $.self,
  count: $.count,
  event: $.event,
})
  .match($.self, "clicks", $.count)
  .match($.self, "~/on/click", $.event)
  .upsert(({ self, count }) => [self, "clicks", count + 1])
  .commit();

export const rules = behavior({
  init,
  view,
  onclick,
});

export const spawn = (input: {} = source) => rules.spawn(input);
