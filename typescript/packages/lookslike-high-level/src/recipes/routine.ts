import { recipe, NAME } from "../builder/index.js";

export const routine = recipe<{ title: string }>("routine", ({ title }) => ({
  [NAME]: title,
}));
