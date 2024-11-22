import { h, behavior, $, select } from "@commontools/common-system";
import { event, events } from "../sugar/event.js";
import { set } from "../sugar/transact.js";

const Empty = select({ self: $.self })
  .not(q => q.match($.self, "clicks", $._))

const Clicks = select({ self: $.self, clicks: $.clicks })
  .match($.self, "clicks", $.clicks)

const CounterEvent = events({
  onReset: '~/on/reset',
  onClick: '~/on/click',
})

const init = Empty
  .update(({ self }) => set(self, { clicks: 0 }))
  .commit();

const viewCount = Clicks.render(({ clicks, self }) => {
  return (
    <div title={`Clicks ${clicks}`} entity={self}>
      <div>{clicks}</div>
      <button onclick={CounterEvent.onClick}>Click me!</button>
      <button onclick={CounterEvent.onReset}>Reset</button>
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
  init,
  viewCount,
  onClick,
  onReset,
});

export const spawn = (source: {} = { counter: 34 }) => rules.spawn(source);
