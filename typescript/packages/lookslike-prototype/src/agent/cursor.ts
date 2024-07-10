import { reactive } from "@vue/reactivity";

type CursorMode =
  | "idle"
  | "sketching"
  | "detailing"
  | "reflecting"
  | "working"
  | "error";

type Focus = {
  id: string;
  element: HTMLElement;
};

export const cursor = reactive({
  position: { x: 0, y: 0 },
  offset: { x: 32, y: 32 },
  state: "idle" as CursorMode,
  userInput: "",
  focus: [] as Focus[] // list of identifiers
});

export const anchor = () => {
  return { x: window.innerWidth / 2, y: window.innerHeight - 32 };
};
