import { CFCalendar } from "./cf-calendar.ts";
if (!customElements.get("cf-calendar")) {
  customElements.define("cf-calendar", CFCalendar);
}
export { CFCalendar };
