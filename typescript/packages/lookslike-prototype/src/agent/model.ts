import { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import { Message } from "../data.js";
import { reactive } from "@vue/reactivity";
import { session } from "../state.js";

export type Thought = { id: number; message: ChatCompletionMessageParam };
export const suggestions = reactive([
  "flip a coin",
  "imagine 3 todos and show them",
  "make me an image of a dog"
]);

export async function updateThought(
  id: number,
  message: ChatCompletionMessageParam
) {}

export async function recordThought(message: Message) {
  session.history.push(message);
}
