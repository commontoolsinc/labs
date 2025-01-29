import { recipe, NAME } from "@commontools/builder";

export const reservation = recipe<{ title: string }>("Reservation", ({ title }) => ({
  [NAME]: title,
}));
