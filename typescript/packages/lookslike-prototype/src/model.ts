import { stream, signal } from "@commontools/common-frp";
import { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import { Signal } from "../../common-frp/lib/signal.js";
const { generate, scan } = stream;

export type Thought = { id: number; message: ChatCompletionMessageParam };
type Sub = (thought: Thought) => void;

const subscribers = [] as Sub[];
function subscribe(cb: Sub) {
  subscribers.push(cb);
  return () => {
    const idx = subscribers.indexOf(cb);
    if (idx >= 0) {
      subscribers.splice(idx, 1);
    }
  };
}

const thoughts = generate<Thought>((send) => subscribe(send));
export const thoughtLog: Signal<{ [id: number]: ChatCompletionMessageParam }> =
  scan(
    thoughts,
    (state, v) => {
      return {
        ...state,
        [v.id]: v.message
      };
    },
    {} as { [id: number]: ChatCompletionMessageParam }
  );

let thoughtId = 0;

export async function updateThought(
  id: number,
  message: ChatCompletionMessageParam
) {
  for (const sub of subscribers) {
    sub({ id: id, message });
  }
}

export async function recordThought(message: ChatCompletionMessageParam) {
  for (const sub of subscribers) {
    sub({ id: thoughtId, message });
  }

  return thoughtId++;
}
