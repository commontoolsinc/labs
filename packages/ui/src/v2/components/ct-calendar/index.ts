import { CTCalendar } from "./ct-calendar.ts";
if (!customElements.get("ct-calendar")) {
  customElements.define("ct-calendar", CTCalendar);
}
export { CTCalendar };
