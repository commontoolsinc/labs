import { CFAccordionItem } from "./cf-accordion-item.ts";

// Register the custom element
if (!customElements.get("cf-accordion-item")) {
  customElements.define("cf-accordion-item", CFAccordionItem);
}

// Export the component class
export { CFAccordionItem };
