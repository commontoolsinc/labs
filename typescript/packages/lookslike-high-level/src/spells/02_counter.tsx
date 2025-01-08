import { h, behavior, $, select, Session } from "@commontools/common-system";
import { event, events, set, subview } from "../sugar.js";
import { description, Description } from "./stickers/describe.jsx";
import { mixin } from "../sugar/mixin.js";
import { Chattable, chatUiResolver } from "./stickers/chat.jsx";
import { log } from "../sugar/activity.js";

const resolveEmpty = select({ self: $.self }).not(q => q.match($.self, "clicks", $._));

const resolveClicks = select({ self: $.self, clicks: $.clicks }).match(
  $.self,
  "clicks",
  $.clicks,
);

const CounterEvent = events({
  onReset: "~/on/reset",
  onClick: "~/on/click",
});

const styles = {
  container: 'display: flex; flex-direction: column; align-items: center; padding: 20px; background: linear-gradient(45deg, #1a1a1a, #2d2d2d); border-radius: 10px; color: #fff; box-shadow: 0 4px 6px rgba(0,0,0,0.1);',
  clicks: 'font-size: 48px; font-weight: bold; color: #0ff; text-shadow: 0 0 10px rgba(0,255,255,0.5); margin: 10px 0;',
  button: 'background: #333; color: #fff; border: 2px solid #0ff; padding: 10px 20px; margin: 5px; border-radius: 5px; cursor: pointer; transition: all 0.3s; font-family: monospace;',
  description: 'font-family: monospace; color: #0ff; margin: 15px 0; text-align: center;'
}

export const rules = behavior({
  // ...mixin(
  //   Description(
  //     ["clicks"],
  //     (self: any) =>
  //       `Come up with a pun based on this counter value: ${self.clicks}. Respond with just the pun directly.`,
  //   ),
  // ),

  ...mixin(Chattable({
    attributes: ["clicks"],
    greeting: '-',
    systemPrompt: ({ clicks }) => `The current counter is at: ${clicks}?`,
  })),

  init: resolveEmpty.update(({ self }) => set(self, { clicks: 0 })).commit(),

  viewCount: resolveClicks
    // .with(description)
    .with(chatUiResolver)
    .render(({ clicks, self, chatView }) => {
      return (
        <div title={`Clicks ${clicks}`} entity={self} style={styles.container}>
          <div style={styles.clicks}>{clicks}</div>
          <div>
            <button style={styles.button} onclick={CounterEvent.onClick}>Click me!</button>
            <button style={styles.button} onclick={CounterEvent.onReset}>Reset</button>
          </div>
          {subview(chatView)}
        </div>
      );
    })
    .commit(),

  onReset: event(CounterEvent.onReset)
    .update(({ self }) => set(self, { clicks: 0 }))
    .commit(),

  onClick: event(CounterEvent.onClick)
    .with(resolveClicks)
    .update(({ self, clicks }) => ([...set(self, { clicks: clicks + 1 }), ...log(self, 'Incremented counter')]))
    .commit(),
});

rules.disableRule('chat/view' as any)

export const spawn = (source: {} = { counter: 34 }) =>
  rules.spawn(source, "Counter");
