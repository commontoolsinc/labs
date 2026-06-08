/**
 * Test: Event RSVP — identity-correct, read-only RSVP exemplar.
 *
 * Drives every handler via its Stream `.send()` and asserts on the SHARED cells
 * via raw `.get()` (reactive traversal through PerSpace array elements returns
 * undefined — the documented PerSpace-array-element bug, also noted in
 * scoped-user-directory's test).
 *
 * Single-identity caveat (CT-1598): the harness dispatches every action from one
 * identity, so we exercise ONE viewer's full lifecycle. That viewer's #profile
 * wishes don't resolve in this harness, so join/create are given an explicit
 * snapshot via the optional event overrides — the same name/avatar SNAPSHOT the
 * UI would copy from #profile. Identity is still the cell reference in `me`.
 *
 * The load-bearing identity proof is the RSVP test: after join, sending
 * `setRsvp` mutates `attendees.get()[0]` — proving the RSVP is keyed by the `me`
 * cell REFERENCE (the write goes through `me.attendee`), not by a name string.
 *
 * Run: deno task cf test packages/patterns/event-rsvp/main.test.tsx
 */
import { action, computed, pattern, Writable } from "commonfabric";
import EventRsvp, {
  type Attendee,
  type EventDetails,
  type MePointer,
} from "./main.tsx";

export default pattern(() => {
  const event = Writable.of<EventDetails>({
    title: "",
    dateTime: "",
    location: "",
    organizer: { displayName: "", avatar: "" },
    created: "",
  });
  const attendees = Writable.of<Attendee[]>([]);
  const me = Writable.of<MePointer>({});

  const subject = EventRsvp({ event, attendees, me });

  // === Actions ===

  const action_create_event = action(() => {
    subject.createEvent.send({
      title: "Game Night",
      dateTime: "Fri 7pm",
      location: "My place",
      // Snapshot of the creator (stands in for #profile in this harness).
      organizerName: "Ada",
      organizerAvatar: "🦊",
    });
  });

  const action_join = action(() => {
    subject.joinWithProfile.send({ displayName: "Ada", avatar: "🦊" });
  });

  // Joining twice must be a no-op (membership is the existing `me` reference).
  const action_join_again = action(() => {
    subject.joinWithProfile.send({ displayName: "Ada Again", avatar: "🐢" });
  });

  const action_rsvp_maybe = action(() => {
    subject.setRsvp.send({ status: "maybe" });
  });

  const action_rsvp_going = action(() => {
    subject.setRsvp.send({ status: "going" });
  });

  const action_rsvp_notgoing = action(() => {
    subject.setRsvp.send({ status: "notgoing" });
  });

  const action_set_guests = action(() => {
    subject.setGuests.send({ guestCount: 2 });
  });

  const action_set_message = action(() => {
    subject.setMessage.send({ message: "Bringing dessert!" });
  });

  // === Assertions ===

  // -- Event creation: organizer is a SNAPSHOT, not a typed name field. --
  const assert_no_event_initially = computed(() => event.get().created === "");
  const assert_event_created = computed(() => {
    const e = event.get();
    return e.title === "Game Night" &&
      e.dateTime === "Fri 7pm" &&
      e.location === "My place" &&
      e.created !== "";
  });
  const assert_organizer_snapshot = computed(() => {
    const org = event.get().organizer;
    return org.displayName === "Ada" && org.avatar === "🦊";
  });

  // -- Join: snapshots identity into the roster + records a cell reference. --
  const assert_roster_empty = computed(() => attendees.get().length === 0);
  const assert_me_unset = computed(() => me.get().attendee === undefined);

  const assert_joined_snapshot = computed(() => {
    const list = attendees.get();
    const a = list[0];
    return list.length === 1 &&
      a?.displayName === "Ada" &&
      a?.avatar === "🦊" &&
      a?.status === "going" && // default RSVP
      a?.guestCount === 0 &&
      a?.message === "";
  });
  // `me` now points at the row (membership via reference, not name match).
  // Read through the reactive OUTPUT `subject.me` — a raw `me.get().attendee`
  // does not expose the stored link in this harness, but the reactive pointer
  // resolves through it (cf. scoped-user-directory: `subject.me.user?...`).
  const assert_me_points_at_row = computed(() =>
    subject.me.attendee !== undefined &&
    subject.me.attendee?.displayName === "Ada"
  );

  // Re-joining is a no-op: still one row, name unchanged (proves we keyed on
  // the existing `me` reference, not on a name string).
  const assert_join_again_noop = computed(() => {
    const list = attendees.get();
    return list.length === 1 && list[0]?.displayName === "Ada";
  });

  // -- RSVP keyed by the member REFERENCE: setRsvp writes through `me.attendee`
  //    and the change is visible on the SHARED roster row. This is the
  //    link-not-copy proof (cf. scoped-user-directory's rename test). --
  const assert_rsvp_maybe = computed(() =>
    attendees.get()[0]?.status === "maybe"
  );
  const assert_rsvp_updated_notgoing = computed(() =>
    attendees.get()[0]?.status === "notgoing"
  );
  const assert_rsvp_back_to_going = computed(() =>
    attendees.get()[0]?.status === "going"
  );

  // -- Guests + headcount (going people + their guests). --
  const assert_guests_set = computed(() =>
    attendees.get()[0]?.guestCount === 2
  );
  // 1 going person + 2 guests = 3.
  const assert_headcount = computed(() =>
    subject.goingCount === 1 && subject.headcount === 3
  );
  // When not going, that row drops out of both counts.
  const assert_headcount_zero_when_notgoing = computed(() =>
    subject.goingCount === 0 && subject.headcount === 0
  );

  // -- Message written through the reference too. --
  const assert_message_set = computed(() =>
    attendees.get()[0]?.message === "Bringing dessert!"
  );

  return {
    tests: [
      // Initial empty state
      { assertion: assert_no_event_initially },
      { assertion: assert_roster_empty },
      { assertion: assert_me_unset },

      // Create the event → organizer captured as a snapshot
      { action: action_create_event },
      { assertion: assert_event_created },
      { assertion: assert_organizer_snapshot },

      // Join → identity snapshot + cell-reference pointer
      { action: action_join },
      { assertion: assert_joined_snapshot },
      { assertion: assert_me_points_at_row },

      // Re-join is a no-op (keyed on the reference, not the name)
      { action: action_join_again },
      { assertion: assert_join_again_noop },

      // RSVP set + update — keyed by the member reference (writes hit the
      // shared roster row through `me.attendee`)
      { action: action_rsvp_maybe },
      { assertion: assert_rsvp_maybe },
      { action: action_rsvp_notgoing },
      { assertion: assert_rsvp_updated_notgoing },
      // Headcount excludes a not-going attendee
      { assertion: assert_headcount_zero_when_notgoing },
      { action: action_rsvp_going },
      { assertion: assert_rsvp_back_to_going },

      // Guests + live headcount (going people + guests)
      { action: action_set_guests },
      { assertion: assert_guests_set },
      { assertion: assert_headcount },

      // Note written through the reference
      { action: action_set_message },
      { assertion: assert_message_set },
    ],
    subject,
  };
});
