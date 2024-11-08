import { h, behavior, $, Reference, select, View } from "@commontools/common-system";
import { b } from "../sugar.jsx";

export const source = { clicker: { v: 32 } };

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

// const view =
//   b.object({ clicks: b.number(), })
//     .render(({ self, clicks }: { self: Reference; clicks: number; }) => {
//       return (
//         <div title={`Clicks ${clicks}`} entity={self}>
//           <div>{clicks}</div>
//           <button onclick="~/on/click">Click me!</button>
//         </div>
//       );
//     });

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
