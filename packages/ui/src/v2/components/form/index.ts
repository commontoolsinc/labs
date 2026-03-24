import { CFForm } from "./cf-form.ts";

if (!customElements.get("cf-form")) {
  customElements.define("cf-form", CFForm);
}

export { CFForm };
export type { CFForm as CFFormElement };

// Re-export form context types and utilities
export {
  type FieldRegistration,
  type FormContext,
  formContext,
  type ValidationResult,
} from "./form-context.ts";
