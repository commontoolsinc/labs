import { recipe, NAME } from "@commontools/common-builder";

export const reservation = recipe<{ title: string }>(
  "Reservation",
  ({ title }) => ({
    [NAME]: title,
  }),
);
