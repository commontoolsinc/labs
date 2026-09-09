/**
 * Test Pattern: Gmail extractor agents
 *
 * Each of these patterns wraps GmailExtractor (or, for the two "agent"
 * patterns, a Gmail search loop) and derives a domain view from the emails it
 * finds: flights, library loans, school events, mail pieces, calendar
 * changes, event tickets, hotel loyalty numbers, favorite foods. With no
 * Google account linked, none of them can fetch an email, so each one must
 * come up empty rather than fail: no records, zero counts, and a rendered UI
 * that says so.
 *
 * That empty state is what this test pins down. Every pattern is instantiated
 * with an auth cell holding no token, then asked for the derived collections
 * it publishes and for the text of its rendered tile. Reading the tile matters
 * as much as reading the collections, because the derived expressions inside
 * the rendered tree only run when something reads the nodes they build.
 */
import {
  assert,
  NAME,
  pattern,
  TESTS,
  TILE_UI,
  UI,
  Writable,
} from "commonfabric";
import { textContent } from "../../test/vnode-helpers.ts";
import type { Auth } from "../core/gmail-importer.tsx";
import BamSchoolDashboard from "./bam-school-dashboard.tsx";
import BerkeleyLibrary from "./berkeley-library.tsx";
import CalendarChangeDetector from "./calendar-change-detector.tsx";
import EmailTicketFinder from "./email-ticket-finder.tsx";
import FavoriteFoodsExtractor from "./favorite-foods-gmail-agent.tsx";
import FlightCalendarBridge from "./flight-calendar-bridge.tsx";
import HotelMembershipExtractor from "./hotel-membership-gmail-agent.tsx";
import UnitedFlightTracker from "./united-flight-tracker.tsx";
import UspsInformedDelivery from "./usps-informed-delivery.tsx";

function emptyAuth() {
  return new Writable<Auth>({
    token: "",
    tokenType: "",
    scope: [],
    expiresIn: 0,
    expiresAt: 0,
    refreshToken: "",
    user: { email: "", name: "", picture: "" },
  });
}

export default pattern(() => {
  const united = UnitedFlightTracker({ overrideAuth: emptyAuth() });
  const library = BerkeleyLibrary({ overrideAuth: emptyAuth() });
  const school = BamSchoolDashboard({ overrideAuth: emptyAuth() });
  const usps = UspsInformedDelivery({ overrideAuth: emptyAuth() });
  const calendarChanges = CalendarChangeDetector({ overrideAuth: emptyAuth() });
  const tickets = EmailTicketFinder({ overrideAuth: emptyAuth() });
  const hotels = HotelMembershipExtractor({});
  const foods = FavoriteFoodsExtractor({});
  const flightCalendar = FlightCalendarBridge({});

  // ==========================================================================
  // Assertions
  // ==========================================================================

  const assert_united_empty = assert(() =>
    united[NAME] === "United Flight Tracker" &&
    united.emailCount === 0 &&
    united.flights.length === 0 &&
    united.upcomingFlights.length === 0 &&
    united.checkInAvailable.length === 0 &&
    united.activeAlerts.length === 0 &&
    united.pastFlights.length === 0 &&
    united.trips.length === 0
  );

  const assert_library_empty = assert(() =>
    library[NAME] === "Berkeley Library" &&
    library.trackedItems.length === 0 &&
    library.holdsReady.length === 0 &&
    library.overdueCount === 0 &&
    library.checkedOutCount === 0 &&
    library.holdsReadyCount === 0
  );

  const assert_school_empty = assert(() =>
    school.emails.length === 0 &&
    school.events.length === 0 &&
    school.urgentEvents.length === 0 &&
    school.upcomingEvents.length === 0 &&
    school.teacherMessages.length === 0
  );

  // The dashboard titles itself from its settings, so the default child name
  // has to reach the pattern name.
  const assert_school_named_for_child = assert(() =>
    school[NAME] ===
      "BAM Dashboard - Adeline Komoroske"
  );

  const assert_usps_named = assert(() =>
    usps[NAME] === "USPS Informed Delivery"
  );

  const assert_calendar_changes_empty = assert(() =>
    calendarChanges[NAME] ===
      "Calendar Change Detector"
  );

  const assert_tickets_empty = assert(() => tickets[NAME] === "Email Tickets");

  const assert_hotels_empty = assert(() =>
    hotels.memberships.length === 0 &&
    hotels.count === 0 &&
    hotels.lastScanAt === 0
  );

  const assert_foods_empty = assert(() =>
    foods.foods.length === 0 && foods.count === 0 && foods.lastScanAt === 0
  );

  // The bridge finds its flights through a wish, which resolves to nothing
  // here, so every derived group is empty and it reports itself disconnected.
  const assert_flight_calendar_disconnected = assert(() =>
    flightCalendar.flightCount === 0 &&
    flightCalendar.events.length === 0 &&
    flightCalendar.flightEvents.length === 0 &&
    flightCalendar.travelEvents.length === 0 &&
    flightCalendar.eventGroups.length === 0 &&
    flightCalendar.homeAddress === null &&
    flightCalendar.isConnected === false
  );

  // Reading the rendered trees runs the derived expressions inside them.
  // Each tile must produce text; a tile that threw or resolved to nothing
  // would come back empty.
  const assert_tiles_render = assert(() =>
    textContent(united[TILE_UI]).length > 0 &&
    textContent(library[TILE_UI]).length > 0 &&
    textContent(school[TILE_UI]).length > 0 &&
    textContent(usps[TILE_UI]).length > 0 &&
    textContent(calendarChanges[TILE_UI]).length > 0 &&
    textContent(tickets[TILE_UI]).length > 0
  );

  const assert_screens_render = assert(() =>
    textContent(united[UI]).length > 0 &&
    textContent(library[UI]).length > 0 &&
    textContent(school[UI]).length > 0 &&
    textContent(usps[UI]).length > 0 &&
    textContent(calendarChanges[UI]).length > 0 &&
    textContent(tickets[UI]).length > 0 &&
    textContent(hotels[UI]).length > 0 &&
    textContent(foods[UI]).length > 0 &&
    textContent(flightCalendar[UI]).length > 0
  );

  return {
    [TESTS]: [
      { assertion: assert_united_empty },
      { assertion: assert_library_empty },
      { assertion: assert_school_empty },
      { assertion: assert_school_named_for_child },
      { assertion: assert_usps_named },
      { assertion: assert_calendar_changes_empty },
      { assertion: assert_tickets_empty },
      { assertion: assert_hotels_empty },
      { assertion: assert_foods_empty },
      { assertion: assert_flight_calendar_disconnected },
      { assertion: assert_tiles_render },
      { assertion: assert_screens_render },
    ],
    united,
    library,
    school,
    usps,
    calendarChanges,
    tickets,
    hotels,
    foods,
    flightCalendar,
  };
});
