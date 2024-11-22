import { customElement } from "lit-element/decorators.js";
import { eventProps } from "../hyperscript/schema-helpers.js";
import { view } from "../hyperscript/render.js";
import * as System from "@commontools/common-system";

export const cardContainer = view("common-charm", {
  spell: { type: "object" },
  ...eventProps(),
});

@customElement("common-charm")
export class CommonCharm extends System.Charm {}
