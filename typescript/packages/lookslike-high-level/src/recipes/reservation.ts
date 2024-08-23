import { recipe, NAME } from "../builder/index.js";

export const reservation = recipe<{ title: string }>(
  "reservation",
  ({ title }) => ({
    [NAME]: title,
  })
);
