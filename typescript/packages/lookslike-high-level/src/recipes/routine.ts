import { recipe, NAME } from "@commontools/builder";

export const routine = recipe<{ title: string }>("Routine", ({ title }) => ({
  [NAME]: title,
}));
