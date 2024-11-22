import {
  h,
  behavior,
  $,
  Reference,
  select,
} from "@commontools/common-system";
import { event, Events } from "../sugar/event.js";
import { set as set } from "../sugar/transact.js";

export const source = { clicker: { v: 33 } };

const Empty = select({ self: $.self })
  .not(q => q.match($.self, "clicks", $._))

const Clicks = select({ self: $.self, clicks: $.clicks })
  .match($.self, "clicks", $.clicks)

const events: Events = {
  onReset: '~/on/reset',
  onClick: '~/on/click',
}

const init = Empty
  .update(({ self }) => set(self, { clicks: 0 }))
  .commit();

const viewCount = Clicks.render(({ clicks, self }) => {
  return (
    <div title={`Clicks ${clicks}`} entity={self}>
      <div>{clicks}</div>
      <button onclick={events.onClick}>Click me!</button>
    </div>
  );
})
  .commit();

const onReset = event(events.onReset)
  .update(({ self }) => set(self, { clicks: 0 }))
  .commit();

const onClick = event(events.onClick)
  .with(Clicks)
  .update(({ self, clicks }) => set(self, { clicks: clicks + 1 }))
  .commit();

export const rules = behavior({
  init,
  viewCount,
  onClick,
  onReset,
});

export const spawn = (input: {} = source) => rules.spawn(input);
