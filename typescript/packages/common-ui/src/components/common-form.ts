import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { baseStyles } from "./style.js";
import { view } from "../hyperscript/render.js";
import { eventProps } from "../hyperscript/schema-helpers.js";

export const commonForm = view("common-form", {
  ...eventProps(),
});

export type CommonFormSubmit = {
  formData: FormData;
};

export class CommonFormSubmitEvent extends Event {
  detail: CommonFormSubmit;

  constructor(detail: CommonFormSubmit) {
    super("common-submit", { bubbles: true, composed: true });
    this.detail = detail;
  }
}

@customElement("common-form")
export class CommonFormElement extends LitElement {
  @property({ type: Boolean }) reset = false;

  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
      }

      form {
        display: contents;
      }
    `,
  ];

  // Override createRenderRoot to opt out of shadow DOM
  override createRenderRoot() {
    return this;
  }

  override render() {
    const onSubmit = (event: Event) => {
      event.preventDefault();
      const form = event.target as HTMLFormElement;
      const formData = new FormData(form);
      console.log("form data", formData);
      this.dispatchEvent(new CommonFormSubmitEvent({ formData }));
      if (this.reset) {
        form.reset();
      }
    };

    return html`
      <form id="${this.id}" @submit="${onSubmit}">
        ${this.hasChildNodes()
          ? html`<span>${Array.from(this.children)}</span>`
          : nothing}
      </form>
    `;
  }
}
