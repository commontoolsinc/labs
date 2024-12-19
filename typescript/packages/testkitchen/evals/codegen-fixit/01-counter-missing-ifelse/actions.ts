import { Action } from "../../../types.ts";

export const actions: Action[] = [
  {
    type: "assert",
    name: "Assert initial count is 0",
    args: ["heading", { name: "0", level: 1 }]
  },
  {
    type: "click",
    name: "Click increment button first time",
    args: ["button", { name: "Increment" }]
  },
  {
    type: "click",
    name: "Click increment button second time",
    args: ["button", { name: "Increment" }]
  },
  {
    type: "assert",
    name: "Assert WOW is not shown",
    args: ["heading", { name: "WOW!", level: 2, notVisible: true }]
  },
  {
    type: "click",
    name: "Click increment button third time",
    args: ["button", { name: "Increment" }]
  },
  {
    type: "assert",
    name: "Assert final count is 3",
    args: ["heading", { name: "3", level: 1, expected: "3" }]
  },
  {
    type: "assert",
    name: "Assert WOW is shown",
    args: ["heading", { name: "WOW!", level: 2, expected: "WOW!" }]
  }
]; 