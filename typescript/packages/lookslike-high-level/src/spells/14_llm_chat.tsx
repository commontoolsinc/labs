import {
  h,
  behavior,
  Session,
} from "@commontools/common-system";
import { mixin } from "../sugar/mixin.js";
import { chatResolver, Chattable, chatUiResolver } from "./stickers/chat.jsx";

export const source = { chat: { v: 1 } };

export const chatRules = behavior({
  ...mixin(Chattable({
    greeting: 'yo',
    systemPrompt: () => 'speak only in riddles'
  })),

  view: chatResolver
    .with(chatUiResolver)
    .render(({ chatView }) => {
      const view = chatView == null ? <div>Loading...</div> : Session.resolve(chatView)

      return <div title="Common Chat">
        {view}
      </div>
    })
    .commit(),
});

console.log(chatRules)

export const spawn = (input: {} = source) => chatRules.spawn(input, "Chat");
