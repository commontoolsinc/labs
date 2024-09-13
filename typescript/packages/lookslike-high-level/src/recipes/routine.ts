import { recipe, NAME } from "@commontools/common-builder";

export const routine = recipe<{ title: string }>("routine", ({ title }) => ({
  [NAME]: title,
}));
