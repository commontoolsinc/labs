import { Action } from "../../actions.ts";

export const actions: Action[] = [
  {
    type: "click",
    name: "add the first kitty",
    args: ["button", { name: "Adopt A Kitty" }],
  },
  {
    type: "click",
    name: "pet the first kitty",
    args: ["button", { name: "Pat Kitty" }],
  },
];
