import { CTAutocomplete, type AutocompleteItem } from "./ct-autocomplete.ts";

if (!customElements.get("ct-autocomplete")) {
  customElements.define("ct-autocomplete", CTAutocomplete);
}

export { CTAutocomplete };
export type { AutocompleteItem };
