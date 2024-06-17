import { stream, signal } from "@commontools/common-frp";
import { ChatCompletionMessageParam } from "openai/resources/index.mjs";
<<<<<<< HEAD:typescript/packages/lookslike-prototype/src/model.ts
import { Signal, SignalSubject } from "../../common-frp/lib/signal.js";
=======
import { Signal } from "../../common-frp/lib/signal.js";
>>>>>>> origin/main:typescript/packages/lookslike-prototype/src/agent/model.ts
const { subject, scan } = stream;

export type Thought = { id: number; message: ChatCompletionMessageParam };
type Sub = (thought: Thought) => void;
export const suggestions = signal.state([
  "flip a coin",
  "imagine 3 todos and show them",
  "make me an image of a dog"
] as string[]);

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

const thoughts = subject<Thought>();
subscribe(thoughts.send);

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
