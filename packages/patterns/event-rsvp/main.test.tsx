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
import { action, computed, pattern, UI, Writable } from "commonfabric";
import EventRsvp, {
  type Attendee,
  type EventDetails,
  type MePointer,
} from "./main.tsx";

// ===========================================================================
// Render smoke-test helpers (inlined so this test stays self-contained in its
// own directory — no --root needed).
//
// These walk the REALIZED `[UI]` VNode tree, calling `.get()` on every nested
// cell/computed as they descend. That forces the pattern's computed `[UI]`
// subtrees to evaluate, which is when `h()` runs on each `$`-bound control. On
// the OLD (broken) structure — where `$value`/`$profile` controls lived inside
// `computed(() => …)` subtrees — descending into them made `h()` throw
// "Bidirectionally bound property … is not reactive", which the test runner
// surfaces as a failing runtime error (and the node is never found). With the
// fixed static structure the traversal succeeds and the controls are found.
//
// (Same approach as packages/patterns/cfc-group-chat-demo/main.test.tsx, which
// imports these from ../test-ui-helpers.ts; inlined here to avoid the --root
// requirement and to keep edits within the event-rsvp directory.)
// ===========================================================================

type AnyRecord = Record<PropertyKey, unknown>;

const isRecord = (value: unknown): value is AnyRecord =>
  typeof value === "object" && value !== null;

// Resolve a value that may be a Cell/computed by calling `.get()`. This is the
// step that *drives* evaluation of the [UI] computed subtrees.
const readValue = (value: unknown): unknown => {
  if (!isRecord(value) || typeof value.get !== "function") return value;
  return (value.get as () => unknown)();
};

const propsOf = (node: unknown): AnyRecord | undefined => {
  const value = readValue(node);
  if (!isRecord(value)) return undefined;
  const props = readValue(value.props);
  return isRecord(props) ? props : undefined;
};

const childrenArray = (children: unknown): unknown[] => {
  const value = readValue(children);
  if (Array.isArray(value)) return value;
  return value === undefined || value === null || typeof value === "boolean"
    ? []
    : [value];
};

const childNodes = (node: unknown): unknown[] => {
  const value = readValue(node);
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  const ui = (value as AnyRecord)[UI];
  return [
    ...(ui === undefined || ui === value ? [] : [ui]),
    ...childrenArray(value.children),
  ];
};

// Depth-first search for a node whose prop `prop` reads as `expected`. Visiting
// every node forces every nested computed (and thus every `h()` call) to run.
const findNodeByProp = (
  root: unknown,
  prop: string,
  expected: unknown,
): unknown | undefined => {
  const value = readValue(root);
  const props = propsOf(value);
  if (props && readValue(props[prop]) === expected) return value;
  return childNodes(value)
    .map((child) => findNodeByProp(child, prop, expected))
    .find((child) => child !== undefined);
};

const findNodeById = (root: unknown, id: string): unknown | undefined =>
  findNodeByProp(root, "id", id);

// True iff `id` is present in the realized [UI] tree AND it carries the given
// `$`-bound prop as a live binding (an object/link, never a plain string — a
// plain string would mean h() unwrapped it, i.e. the broken computed case).
const hasLiveBinding = (
  root: unknown,
  id: string,
  boundProp: string,
): boolean => {
  const node = findNodeById(root, id);
  const props = propsOf(node);
  if (!props) return false;
  const bound = props[boundProp];
  // After h() runs at a static position the prop is a binding-target link
  // (an object), not the raw cell and not a primitive.
  return typeof bound === "object" && bound !== null;
};

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

  // ===== RENDER SMOKE TEST =====
  // These assertions WALK the realized `subject[UI]` tree. Walking forces every
  // computed `[UI]` subtree to evaluate, which runs `h()` on every `$`-bound
  // control. The OLD structure put `$value`/`$profile` controls inside
  // `computed(() => …)` subtrees, so this walk would make `h()` throw
  // "Bidirectionally bound property … is not reactive" — a runtime error that
  // FAILS the run, and the control would never be found. With the fix, every
  // `$`-binding is static, so the walk succeeds and each control is present
  // with a live binding (an object link, not an unwrapped primitive).
  //
  // Note: `ifElse(eventCreated, eventView, createForm)` means the create-form
  // controls are in the tree BEFORE create, and the event-view controls are in
  // the tree AFTER create — so we check each in the matching phase.

  // Before create (create-form branch is active): the three `$value` inputs and
  // the "Hosting as" `$profile` badge must all render at static positions.
  const assert_render_create_form = computed(() =>
    hasLiveBinding(subject[UI], "event-title-input", "$value") &&
    hasLiveBinding(subject[UI], "event-when-input", "$value") &&
    hasLiveBinding(subject[UI], "event-where-input", "$value") &&
    hasLiveBinding(subject[UI], "hosting-as-badge", "$profile")
  );
  // Sanity: the event-view-only controls are NOT in the tree before create.
  const assert_render_no_event_view_before_create = computed(() =>
    findNodeById(subject[UI], "you-are-badge") === undefined &&
    findNodeById(subject[UI], "note-input") === undefined
  );

  // After create (event-view branch is active): the "You are" `$profile` badge
  // and the note `$value` input must render at static positions.
  const assert_render_event_view = computed(() =>
    hasLiveBinding(subject[UI], "you-are-badge", "$profile") &&
    hasLiveBinding(subject[UI], "note-input", "$value")
  );

  return {
    tests: [
      // Initial empty state
      { assertion: assert_no_event_initially },
      { assertion: assert_roster_empty },
      { assertion: assert_me_unset },

      // RENDER SMOKE (create-form phase): walk [UI]; every `$`-bound create-form
      // control must render at a static position. This FAILS on the old
      // computed-wrapped `$value`/`$profile` structure (h() throws "not
      // reactive") and PASSES on the static fix.
      { assertion: assert_render_create_form },
      { assertion: assert_render_no_event_view_before_create },

      // Create the event → organizer captured as a snapshot
      { action: action_create_event },
      { assertion: assert_event_created },
      { assertion: assert_organizer_snapshot },

      // RENDER SMOKE (event-view phase): after create, ifElse swaps in the
      // event view; its "You are" `$profile` badge and note `$value` input must
      // render at static positions (would throw on the old structure).
      { assertion: assert_render_event_view },

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
