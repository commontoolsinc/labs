import { h, behavior, $, select, Session } from "@commontools/common-system";
import { defaultTo, event, events, set } from "../sugar.js";
import { description, Description } from "./stickers/describe.jsx";
import { mixin } from "../sugar/mixin.js";
import { Commentable } from "./stickers/comments.jsx";
import { ChatMessageList, ChatResolver, ChatSubmitForm, Chattable, ChatUiResolver, Messages, sendMessage } from "./stickers/chat.jsx";
import { CommonFormSubmitEvent } from "../../../common-ui/lib/components/common-form.js";

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

const viewCount = Clicks
  .with(description)
  .with(ChatUiResolver)
  .render(({ clicks, self, llmDescription, chatView }) => {
    const view = chatView == null ? <div>Placeholder!</div> : Session.resolve(chatView)
    const containerStyle = 'display: flex; flex-direction: column; align-items: center; padding: 20px; background: linear-gradient(45deg, #1a1a1a, #2d2d2d); border-radius: 10px; color: #fff; box-shadow: 0 4px 6px rgba(0,0,0,0.1);'
    const clicksStyle = 'font-size: 48px; font-weight: bold; color: #0ff; text-shadow: 0 0 10px rgba(0,255,255,0.5); margin: 10px 0;'
    const buttonStyle = 'background: #333; color: #fff; border: 2px solid #0ff; padding: 10px 20px; margin: 5px; border-radius: 5px; cursor: pointer; transition: all 0.3s; font-family: monospace;'
    const descriptionStyle = 'font-family: monospace; color: #0ff; margin: 15px 0; text-align: center;'

    return (
      <div title={`Clicks ${clicks}`} entity={self} style={containerStyle}>
        <div style={clicksStyle}>{clicks}</div>
        <div>
          <button style={buttonStyle} onclick={CounterEvent.onClick}>Click me!</button>
          <button style={buttonStyle} onclick={CounterEvent.onReset}>Reset</button>
        </div>
        <p style={descriptionStyle}>{llmDescription}</p>
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

  ...mixin(Chattable({
    attributes: ["clicks"],
    greeting: '-',
    systemPrompt: ({ clicks }) => `The current counter is at: ${clicks}?`,
  })),

  init,
  viewCount,
  onClick,
  onReset,

  onSubmit: event('~/on/submit')
    .update(({ self, event }) => {
      const payload = Session.resolve<CommonFormSubmitEvent>(event)
      const userMessage = payload.detail.formData.get('message')

      return [
        sendMessage(self, { message: userMessage as string })
      ];
    })
    .commit(),
});

export const spawn = (source: {} = { counter: 34 }) =>
  rules.spawn(source, "Counter");
