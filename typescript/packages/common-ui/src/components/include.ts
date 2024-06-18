import { LitElement, html } from "lit-element";
import { customElement, property } from "lit-element/decorators.js";
import { view, render, RenderContext } from "../hyperscript/render.js";
import { VNode } from "../hyperscript/view.js";
import { eventProps } from "../hyperscript/schema-helpers.js";

export const include = view("common-include", {
  ...eventProps(),
  content: { type: "array" },
});

@customElement("common-include")
export class IncludeElement extends LitElement {
  @property({ type: Array })
  content: [VNode, RenderContext];

  override render() {
    const element = render(...this.content);

    return html`${element}`;
  }
}
