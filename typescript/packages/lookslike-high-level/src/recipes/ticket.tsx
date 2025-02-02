import { h } from "@commontools/html";
import { recipe, NAME, UI } from "@commontools/builder";

export const ticket = recipe<{
  title: string;
  show: string;
  location: string;
  date: string;
}>("Ticket", ({ title, show, location, date }) => ({
  [UI]: (
    <div>
      Ticket: {show} in {location} on {date}
    </div>
  ),
  [NAME]: title,
}));
