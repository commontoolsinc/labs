import { recipe, NAME, UI } from "@commontools/common-builder";
import { h, Fragment } from "../jsx";

export const ticket = recipe<{
  title: string;
  show: string;
  location: string;
  date: string;
}>("ticket", ({ title, show, location, date }) => ({
  [UI]: <div>Ticket: {show} in {location} on {date}</div>,
  [NAME]: title,
}));
