import { LitElement, html } from "lit-element";
import { customElement, property } from "lit-element/decorators.js";
import { view, render } from "../hyperscript/render.js";
import { VNode } from "../hyperscript/view.js";
import { eventProps } from "../hyperscript/schema-helpers.js";

export const include = view("common-include", {
  ...eventProps(),
  // TODO; This should be split into two properties, vdom and context
  content: { type: "object" },
});

@customElement("common-include")
export class IncludeElement extends LitElement {
  @property({ type: Object })
  content: VNode;

  override render() {
    const element = render(this.content);

    return html`${element}`;
  }
}
