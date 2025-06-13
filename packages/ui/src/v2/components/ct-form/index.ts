import { CTForm } from "./ct-form.ts";

if (!customElements.get("ct-form")) {
  customElements.define("ct-form", CTForm);
}

export { CTForm };
export type { CTForm as CTFormElement };
