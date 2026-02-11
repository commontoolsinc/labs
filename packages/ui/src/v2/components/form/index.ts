import { CTForm } from "./ct-form.ts";

if (!customElements.get("ct-form")) {
  customElements.define("ct-form", CTForm);
}

export { CTForm };
export type { CTForm as CTFormElement };

// Re-export form context types and utilities
export {
  type FieldRegistration,
  type FormContext,
  formContext,
  type ValidationResult,
} from "./form-context.ts";
