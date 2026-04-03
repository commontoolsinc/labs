import { CTAccordionItem } from "./ct-accordion-item.ts";

// Register the custom element
if (!customElements.get("ct-accordion-item")) {
  customElements.define("ct-accordion-item", CTAccordionItem);
}

// Export the component class
export { CTAccordionItem };
