import { reactive } from "@vue/reactivity";
import { Message } from "./data.js";
import { Graph } from "./reactivity/runtime.js";

export type Context<T> = {
  inputs: { [node: string]: { [input: string]: T } };
  outputs: { [node: string]: T };
  cancellation: (() => void)[];
};

export const session = reactive({
  history: [] as Message[],
  requests: [] as string[]
});

export const idk = reactive({
  reactCode: "a",
  speclang: "b",
  transformed: "c"
});

export const appState = reactive({} as any);
export const appGraph = new Graph(appState);

window.__refresh = () => {
  appGraph.update();
};
