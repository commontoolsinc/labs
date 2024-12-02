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

    return (
      <div title={`Clicks ${clicks}`} entity={self}>
        <div>{clicks}</div>
        <button onclick={CounterEvent.onClick}>Click me!</button>
        <button onclick={CounterEvent.onReset}>Reset</button>
        <p>{llmDescription}</p>

        {view}
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
