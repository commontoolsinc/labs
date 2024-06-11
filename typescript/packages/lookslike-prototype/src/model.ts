import { signal, stream } from "@commontools/common-frp";
import { ChatCompletionMessageParam } from "openai/resources/index.mjs";
const { state, effect } = signal;
const { generate, scan } = stream;

const subscribers = [] as Function[];
function subscribe(cb: Function) {
  subscribers.push(cb);
  return () => {
    const idx = subscribers.indexOf(cb);
    if (idx >= 0) {
      subscribers.splice(idx, 1);
    }
  };
}

const thoughts = generate<ChatCompletionMessageParam>((send) =>
  subscribe(send)
);
export const thoughtLog = scan(
  thoughts,
  (state, v) => [...state, v],
  [] as ChatCompletionMessageParam[]
);

export async function recordThought(message: ChatCompletionMessageParam) {
  for (const sub of subscribers) {
    sub(message);
  }

  // const val = thinkingLog.get();
  // val.push(message);
  // thinkingLog.send(val);
}
