import { h, behavior, $, Reference, select } from "@commontools/common-system";

export const source = { clicker: { v: 30 } };

const init = select({ self: $.self })
  .not.match($.self, "clicks", $._)
  .update(({ self }) => {
    return [{ Assert: [self, "clicks", 0] }];
  });

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
  .update(({ self, count }) => {
    return [
      {
        Upsert: [self, "clicks", count + 1],
      },
    ];
  });

export const rules = behavior({
  init,
  view,
  onclick,
});

export const spawn = (input: {} = source) => rules.spawn(input);
