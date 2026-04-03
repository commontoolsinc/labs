import { AccordionType, CTAccordion } from "./ct-accordion.ts";

if (!customElements.get("ct-accordion")) {
  customElements.define("ct-accordion", CTAccordion);
}

export { CTAccordion };
export type { AccordionType };
