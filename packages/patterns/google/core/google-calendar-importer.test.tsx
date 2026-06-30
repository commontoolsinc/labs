/**
 * Test Pattern: GoogleCalendarImporter
 *
 * Verifies direct linked auth is recognized before exposing the calendar fetch
 * action.
 *
 * Run: deno task cf test packages/patterns/google/core/google-calendar-importer.test.tsx --root packages/patterns --verbose
 */
import { computed, pattern, UI, Writable } from "commonfabric";
import { hasText } from "../../test/vnode-helpers.ts";
import GoogleCalendarImporter, {
  type Auth,
} from "./google-calendar-importer.tsx";

const calendarScope = "https://www.googleapis.com/auth/calendar.readonly";
const futureExpiry = 4102444800000;

export default pattern(() => {
  const directAuth = new Writable<Auth>({
    token: "test-token",
    tokenType: "Bearer",
    scope: [calendarScope],
    expiresIn: 3600,
    expiresAt: futureExpiry,
    refreshToken: "refresh-token",
    user: {
      email: "calendar@example.com",
      name: "Calendar User",
      picture: "",
    },
  });

  const importer = GoogleCalendarImporter({
    settings: {
      daysBack: 7,
      daysForward: 30,
      maxResults: 20,
      debugMode: false,
    },
    overrideAuth: directAuth,
  });

  const assert_initial_data_empty = computed(() =>
    importer.events.length === 0 &&
    importer.calendars.length === 0 &&
    importer.eventCount === 0
  );

  const assert_direct_auth_exposes_fetch_control = computed(() =>
    hasText(importer[UI], "Fetch Calendar Events")
  );

  return {
    tests: [
      { assertion: assert_initial_data_empty },
      { assertion: assert_direct_auth_exposes_fetch_control },
    ],
    importer,
  };
});
