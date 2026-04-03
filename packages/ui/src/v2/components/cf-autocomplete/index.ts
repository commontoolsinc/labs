import { type AutocompleteItem, CFAutocomplete } from "./cf-autocomplete.ts";

if (!customElements.get("cf-autocomplete")) {
  customElements.define("cf-autocomplete", CFAutocomplete);
}

export { CFAutocomplete };
export type { AutocompleteItem };
