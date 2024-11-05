import { recipe, NAME } from "@commontools/common-builder";

export const routine = recipe<{ title: string }>("Routine", ({ title }) => ({
  [NAME]: title,
}));
