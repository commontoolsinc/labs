/**
 * Test Pattern: CalendarEventManager
 *
 * Verifies calendar create controls stay inactive until Google auth is ready.
 *
 * Run: deno task cf test packages/patterns/google/core/experimental/calendar-event-manager.test.tsx --root packages/patterns --verbose
 */
import { assert, pattern, UI } from "commonfabric";
import {
  findElementByText,
  hasText,
  propsOf,
  readValue,
} from "../../../test/vnode-helpers.ts";
import CalendarEventManager from "./calendar-event-manager.tsx";

export default pattern(() => {
  const manager = CalendarEventManager({
    draft: {
      summary: "Design review",
      start: "2026-07-02T10:00",
      end: "2026-07-02T10:30",
      calendarId: "primary",
      description: "Review the mockups.",
      location: "Meet",
      attendeesText: "teammate@example.com",
    },
    existingEvent: null,
  });

  const assert_auth_requirement_is_visible = assert(
    () =>
      hasText(manager[UI], "Connect Your Google Account") &&
      hasText(
        manager[UI],
        "Calendar (read events), Calendar (create/edit/delete events)",
      ),
  );

  const assert_create_button_disabled_without_auth = assert(() => {
    const button = findElementByText(manager[UI], "button", "Create Event");
    return readValue(propsOf(button)?.disabled) === true;
  });

  const assert_confirmation_is_not_rendered_without_auth = assert(() =>
    !hasText(manager[UI], "Confirm Calendar Operation") &&
    !hasText(manager[UI], "Create this event")
  );

  return {
    tests: [
      { assertion: assert_auth_requirement_is_visible },
      { assertion: assert_create_button_disabled_without_auth },
      { assertion: assert_confirmation_is_not_rendered_without_auth },
    ],
    manager,
  };
});
