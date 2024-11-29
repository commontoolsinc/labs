import { h, behavior, $, select } from "@commontools/common-system";
import { event, events, set } from "../sugar.js";
import { description, Description } from "./stickers/describe.jsx";
import { mixin } from "../sugar/mixin.js";
import { Commentable } from "./stickers/comments.jsx";

const Empty = select({ self: $.self }).not(q => q.match($.self, "clicks", $._));

const Clicks = select({ self: $.self, clicks: $.clicks }).match(
  $.self,
  "clicks",
  $.clicks,
);

const CounterEvent = events({
  onReset: "~/on/reset",
  onClick: "~/on/click",
});

const init = Empty.update(({ self }) => set(self, { clicks: 0 })).commit();

const viewCount = Clicks.with(description)
  .render(({ clicks, self, llmDescription }) => {
    return (
      <div title={`Clicks ${clicks}`} entity={self}>
        <div>{clicks}</div>
        <button onclick={CounterEvent.onClick}>Click me!</button>
        <button onclick={CounterEvent.onReset}>Reset</button>
        <p>{llmDescription}</p>
      </div>
    );
  })
  .commit();

const onReset = event(CounterEvent.onReset)
  .update(({ self }) => set(self, { clicks: 0 }))
  .commit();

const onClick = event(CounterEvent.onClick)
  .with(Clicks)
  .update(({ self, clicks }) => set(self, { clicks: clicks + 1 }))
  .commit();

export const rules = behavior({
  ...mixin(
    Description(
      ["clicks"],
      (self: any) =>
        `Come up with a pun based on this counter value: ${self.clicks}. Respond with just the pun directly.`,
    ),
  ),

  init,
  viewCount,
  onClick,
  onReset,
});

export const spawn = (source: {} = { counter: 34 }) =>
  rules.spawn(source, "Counter");
