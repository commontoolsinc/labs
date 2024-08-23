import { recipe, NAME } from "../builder/index.js";

export const ticket = recipe<{ title: string }>("ticket", ({ title }) => ({
  [NAME]: title,
}));
