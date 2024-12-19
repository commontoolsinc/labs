import { Action } from "@/actions";

export const actions: Action[] = [
  {
    type: "click",
    name: "Click increment button",
    args: ["button", { name: "Increment" }]
  },
  {
    type: "click",
    name: "Click increment button again",
    args: ["button", { name: "Increment" }]
  },
  {
    type: "click",
    name: "Click decrement button",
    args: ["button", { name: "Decrement" }]
  }
]; 