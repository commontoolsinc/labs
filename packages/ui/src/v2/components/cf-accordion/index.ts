import { AccordionType, CFAccordion } from "./cf-accordion.ts";

if (!customElements.get("cf-accordion")) {
  customElements.define("cf-accordion", CFAccordion);
}

export { CFAccordion };
export type { AccordionType };
