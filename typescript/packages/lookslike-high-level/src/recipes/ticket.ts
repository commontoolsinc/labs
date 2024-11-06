import { html } from "@commontools/common-html";
import { recipe, NAME, UI } from "@commontools/common-builder";

export const ticket = recipe<{
  title: string;
  show: string;
  location: string;
  date: string;
}>("Ticket", ({ title, show, location, date }) => ({
  [UI]: html`<div>Ticket: ${show} in ${location} on ${date}</div>`,
  [NAME]: title,
}));
