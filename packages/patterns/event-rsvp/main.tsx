/**
 * Event RSVP — a teaching exemplar for multi-user IDENTITY done right.
 *
 * The thing to contrast against: a naive RSVP keeps a `name: string` for every
 * attendee and decides "is this me?" with `attendee.name === myName`. That makes
 * the name a *dead string* — there's no link back to a real person, renames
 * desync, two people named "Sam" collide, and nothing is attestable.
 *
 * This pattern does it the read-only-correct way:
 *
 * 1. The current viewer is resolved with `wish("#profile")` — never a self-typed
 *    name field. The live profile cell drives a trusted <cf-profile-badge> ("You"),
 *    and `#profileName` / `#profileAvatar` give the snapshot we copy on join.
 * 2. Joining snapshots the viewer's own { displayName, avatar } into the shared
 *    `attendees` roster (the roster idiom — the app never reads other people's
 *    private profiles), then records a *cell reference* to that row in a per-user
 *    `me` pointer: `me.set({ attendee: attendees.key(idx) })`.
 * 3. The RSVP (status / guestCount / message) lives ON the attendee row, so the
 *    RSVP is keyed by IDENTITY (the cell reference), not by a name string. Updates
 *    are written *through* the `me.attendee` reference. "Is this me?" uses
 *    `equals()` on the reference, never name equality.
 * 4. Other attendees render with <cf-avatar> + a plain name (snapshot only — no
 *    cell, no attestation reachable). <cf-profile-badge> is used ONLY for "You".
 * 5. UI structure: every `$`-bidirectional binding (the `$profile` badges and
 *    the `$value` form inputs) sits at a STATIC `[UI]` position. The two views
 *    (create-form / event-view) are pre-built static subtrees switched with
 *    `ifElse(eventCreated, eventView, createForm)` as a child of a static
 *    wrapper. A `$`-binding regenerated inside a `computed(() => …)` body throws
 *    "Bidirectionally bound property … is not reactive" and blanks the whole
 *    render (h.ts:72-92); only `$`-free derived content (roster, headcount) is
 *    computed here. See main.test.tsx's render smoke test, which guards this.
 *
 * Scope:
 * - `event` + `attendees` (with their RSVPs) are PerSpace — the shared invite
 *   everyone sees and edits.
 * - `me` (the cell-reference pointer) is PerUser — each viewer's own "which row
 *   am I". Form drafts (guests / message in progress) are per-session.
 *
 * Ownership: the organizer is the *profile snapshot* of whoever created the
 * event, displayed with <cf-avatar>. The further "verified" upgrade — attesting
 * authorship with CFC's AuthoredByCurrentUser / RepresentsCurrentUser so the
 * organizer's identity is cryptographically bound — is currently constrained by
 * CT-1665 (owner-protected profile writes fail with "writeAuthorizedBy requires
 * a trusted verified binding identity"), so we deliberately do NOT attempt any
 * owner-protected profile write here. Snapshot-on-create is the read-only story.
 */
import {
  computed,
  Default,
  equals,
  handler,
  ifElse,
  NAME,
  pattern,
  type PerSpace,
  type PerUser,
  safeDateNow,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

// ============ TYPES ============

export type RsvpStatus = "going" | "maybe" | "notgoing";

/** A profile snapshot — the only person data the app copies/stores itself. */
export interface ProfileSnapshot {
  displayName: string;
  avatar?: string;
}

/**
 * One attendee row. The identity snapshot AND the RSVP live together, so the
 * RSVP is keyed by this row's identity (a cell reference), never by name string.
 */
export interface Attendee {
  displayName: string;
  avatar?: string;
  status: RsvpStatus;
  guestCount: number; // additional guests this attendee is bringing
  message: string;
}

export interface EventDetails {
  title: string;
  dateTime: string; // free-form ISO-ish string for the exemplar
  location: string;
  /**
   * The organizer captured as a profile SNAPSHOT at creation time — NOT a typed
   * name string. `created` is non-empty once the event has been created.
   */
  organizer: ProfileSnapshot;
  created: string;
}

/** Per-user pointer holding a CELL REFERENCE to the viewer's own attendee row. */
export interface MePointer {
  attendee?: Attendee;
}

// ---- Handler event shapes ----

export interface CreateEventEvent {
  title?: string;
  dateTime?: string;
  location?: string;
  // Optional organizer snapshot override (see JoinEvent — same rationale: tests
  // and snapshot-in-hand callers; the UI omits these and the handler snapshots
  // the creator's #profile from its bound state).
  organizerName?: string;
  organizerAvatar?: string;
}

/**
 * Join carries no required fields — the UI snapshots the viewer's #profile via
 * the handler's bound state. The optional overrides exist so tests (and any
 * caller that already has a snapshot in hand) can supply one explicitly; the
 * identity story is unchanged either way — it's still a name/avatar SNAPSHOT and
 * identity is still the cell reference recorded in `me`.
 */
export interface JoinEvent {
  displayName?: string;
  avatar?: string;
}

export interface SetRsvpEvent {
  status: RsvpStatus;
}

export interface SetGuestsEvent {
  guestCount: number;
}

export interface SetMessageEvent {
  message: string;
}

// ============ DEFAULTS / CONSTANTS ============

const EMPTY_PROFILE: ProfileSnapshot = { displayName: "", avatar: "" };

const DEFAULT_EVENT: EventDetails = {
  title: "",
  dateTime: "",
  location: "",
  organizer: EMPTY_PROFILE,
  created: "",
};

type EventCell = Writable<EventDetails | Default<typeof DEFAULT_EVENT>>;
type AttendeesCell = Writable<Attendee[] | Default<[]>>;
type MeCell = Writable<MePointer | Default<Record<PropertyKey, never>>>;

const STATUS_LABEL: Record<RsvpStatus, string> = {
  going: "Going",
  maybe: "Maybe",
  notgoing: "Can't go",
};

const STATUS_ORDER: RsvpStatus[] = ["going", "maybe", "notgoing"];

const trimmed = (s: string | undefined): string => (s ?? "").trim();

// ============ HANDLERS ============

/**
 * Create (or overwrite) the shared event. The organizer is captured as a
 * profile SNAPSHOT of the current viewer (resolved from #profile and passed in
 * as plain name/avatar), so ownership is a value copy — no cross-space profile
 * read, no owner-protected write. See the header note re: CFC verified upgrade.
 */
const createEvent = handler<CreateEventEvent, {
  event: EventCell;
  organizerName: string;
  organizerAvatar: string;
}>((ev, { event, organizerName, organizerAvatar }) => {
  const title = trimmed(ev.title);
  if (!title) return;
  event.set({
    title,
    dateTime: trimmed(ev.dateTime),
    location: trimmed(ev.location),
    organizer: {
      displayName: trimmed(ev.organizerName) || trimmed(organizerName),
      avatar: trimmed(ev.organizerAvatar) || trimmed(organizerAvatar),
    },
    created: new Date(safeDateNow()).toISOString(),
  });
});

/**
 * Join the event by snapshotting the viewer's own { displayName, avatar } from
 * #profile into the shared roster, then storing a CELL REFERENCE to that row in
 * the per-user `me` pointer (the scoped-user-directory idiom). Identity is the
 * reference — not the name — so this is safe even if two people share a name.
 */
const joinWithProfile = handler<JoinEvent, {
  attendees: AttendeesCell;
  me: MeCell;
  name: string;
  avatar: string;
}>((ev, { attendees, me, name, avatar }) => {
  // Already joined? `me.attendee` holds a live reference; bail if present.
  // Read via `.key(...)` (cf. scoped-user-directory) — an uninitialized PerUser
  // pointer reads as undefined through `me.get()`, but `me.key("attendee")` is
  // always a valid cell handle.
  if (me.key("attendee").get()) return;
  // Prefer an explicit snapshot from the event; otherwise use the viewer's
  // #profile snapshot bound as state (the UI path).
  const displayName = trimmed(ev.displayName) || trimmed(name);
  if (!displayName) return;
  const av = trimmed(ev.avatar) || trimmed(avatar);
  attendees.push({
    displayName,
    avatar: av,
    status: "going",
    guestCount: 0,
    message: "",
  });
  const idx = attendees.get().length - 1;
  // "me" = a CELL REFERENCE into the shared array, not a copied name/value.
  me.set({ attendee: attendees.key(idx) });
});

/**
 * Set my RSVP status. Writes THROUGH the `me.attendee` reference — the row is
 * found by identity (the pointer), never by scanning for a matching name.
 */
const setRsvp = handler<SetRsvpEvent, { me: MeCell }>(
  ({ status }, { me }) => {
    const attendeeRef = me.key("attendee");
    if (!attendeeRef.get()) return;
    attendeeRef.key("status").set(status);
  },
);

const setGuests = handler<SetGuestsEvent, { me: MeCell }>(
  ({ guestCount }, { me }) => {
    const attendeeRef = me.key("attendee");
    if (!attendeeRef.get()) return;
    const n = Number.isFinite(guestCount)
      ? Math.max(0, Math.floor(guestCount))
      : 0;
    attendeeRef.key("guestCount").set(n);
  },
);

const setMessage = handler<SetMessageEvent, { me: MeCell }>(
  ({ message }, { me }) => {
    const attendeeRef = me.key("attendee");
    if (!attendeeRef.get()) return;
    attendeeRef.key("message").set((message ?? "").slice(0, 280));
  },
);

// ============ INPUT / OUTPUT ============

export interface EventRsvpInput {
  event?: PerSpace<EventDetails | Default<typeof DEFAULT_EVENT>>;
  attendees?: PerSpace<Attendee[] | Default<[]>>;
  me?: PerUser<MePointer | Default<Record<PropertyKey, never>>>;
}

export interface EventRsvpOutput {
  [NAME]: string;
  [UI]: VNode;
  event: PerSpace<EventDetails | Default<typeof DEFAULT_EVENT>>;
  attendees: PerSpace<Attendee[] | Default<[]>>;
  me: PerUser<MePointer | Default<Record<PropertyKey, never>>>;
  goingCount: number;
  headcount: number;
  createEvent: Stream<CreateEventEvent>;
  joinWithProfile: Stream<JoinEvent>;
  setRsvp: Stream<SetRsvpEvent>;
  setGuests: Stream<SetGuestsEvent>;
  setMessage: Stream<SetMessageEvent>;
}

// ============ PATTERN ============

export default pattern<EventRsvpInput, EventRsvpOutput>(
  ({ event, attendees, me }) => {
    // --- Identity: resolve the current viewer's shared profile via wish ---
    // `#profile` is the live cell bound to <cf-profile-badge>; the field targets
    // give the name/avatar strings we snapshot on join. We NEVER add a self-typed
    // name field — the viewer's identity always comes from their profile.
    const profileWish = wish({ query: "#profile" });
    const profileNameWish = wish<string>({ query: "#profileName" });
    const profileAvatarWish = wish<string>({ query: "#profileAvatar" });
    const myProfileName = computed(() => trimmed(profileNameWish.result));
    const myProfileAvatar = computed(() => trimmed(profileAvatarWish.result));
    const hasProfile = computed(() => trimmed(profileNameWish.result) !== "");

    // --- Per-session draft form state (local to each viewer) ---
    const titleDraft = Writable.perSession.of<string>("");
    const dateTimeDraft = Writable.perSession.of<string>("");
    const locationDraft = Writable.perSession.of<string>("");
    const messageDraft = Writable.perSession.of<string>("");

    // --- Bind handlers to their cells ---
    const boundCreate = createEvent({
      event,
      organizerName: myProfileName,
      organizerAvatar: myProfileAvatar,
    });
    const boundJoin = joinWithProfile({
      attendees,
      me,
      name: myProfileName,
      avatar: myProfileAvatar,
    });
    const boundSetRsvp = setRsvp({ me });
    const boundSetGuests = setGuests({ me });
    const boundSetMessage = setMessage({ me });

    // --- Derived: has the event been created yet? ---
    const eventCreated = computed(() => trimmed(event.created) !== "");

    // --- Derived: am I already in the roster? (membership via the reference) ---
    const isJoined = computed(() => me.attendee !== undefined);

    // --- Headcount: going people + their guests (read-only derived) ---
    // NOTE: `attendees` is a PerSpace input cell. Inside a computed() body it
    // auto-unwraps to the plain array, so we iterate it directly (no `.get()`).
    // In handlers we keep `.get()` because the binding is typed as a Writable.
    const goingCount = computed(() => {
      let n = 0;
      for (const a of attendees) if (a.status === "going") n += 1;
      return n;
    });
    const headcount = computed(() => {
      let n = 0;
      for (const a of attendees) {
        if (a.status === "going") n += 1 + (a.guestCount || 0);
      }
      return n;
    });

    // --- Group attendees by status for display (derived array → computed) ---
    const grouped = computed(() =>
      STATUS_ORDER.map((status) => ({
        status,
        label: STATUS_LABEL[status],
        people: attendees.filter((a: Attendee) => a.status === status),
      })).filter((g) => g.people.length > 0)
    );

    // ========================================================================
    // STATIC [UI] subtrees.
    //
    // CRITICAL RULE (packages/html/src/h.ts:72-92): every `$`-bidirectional
    // binding (`$value`, `$profile`, …) must sit at a STATIC position in the
    // `[UI]` tree — i.e. its enclosing `h()` call runs ONCE at pattern-build
    // time, NOT inside a `computed(() => …)` body. At a static position the cell
    // / `wish.result` is still a live Cell, so `h()` passes. Inside a computed
    // the runtime has auto-unwrapped it to a plain value, so `h()` throws
    // "Bidirectionally bound property … is not reactive" and BLANKS the whole
    // render. So we build the create-form and the event-view as static subtrees
    // (their `$`-bound controls constructed once) and switch between them with
    // `ifElse(...)` as a CHILD of a static wrapper. Reactive lists / derived
    // content (roster `.map`, headcount, status grouping) stay in `computed()`,
    // but NONE of those computeds wraps a `$`-bound control. See
    // packages/patterns/fair-share/main.tsx (badge at a static position) and
    // packages/patterns/scope-bug-computed-vnode-blank/main.tsx (the repro).
    // ========================================================================

    // ----- Create form (shown before the event exists). All `$value` inputs
    // and the "Hosting as" <cf-profile-badge> are STATIC here. -----
    const createForm = (
      <cf-card>
        <cf-vstack gap="3">
          <cf-heading level={3}>Create your event</cf-heading>
          <cf-vstack gap="1">
            <cf-label>Title</cf-label>
            <cf-input
              id="event-title-input"
              $value={titleDraft}
              placeholder="Game night"
            />
          </cf-vstack>
          <cf-hstack gap="3" wrap>
            <cf-vstack gap="1" style={{ flex: 1 }}>
              <cf-label>When</cf-label>
              <cf-input
                id="event-when-input"
                $value={dateTimeDraft}
                placeholder="Fri 7pm"
              />
            </cf-vstack>
            <cf-vstack gap="1" style={{ flex: 1 }}>
              <cf-label>Where</cf-label>
              <cf-input
                id="event-where-input"
                $value={locationDraft}
                placeholder="My place"
              />
            </cf-vstack>
          </cf-hstack>
          {
            /* The organizer snapshot is taken from #profile on create; show who
              that will be via the trusted badge. STATIC position — `$profile`
              must never be regenerated inside a computed. */
          }
          <cf-hstack gap="2" align="center" wrap>
            <cf-text variant="caption" tone="muted">
              Hosting as
            </cf-text>
            <cf-profile-badge
              id="hosting-as-badge"
              $profile={profileWish.result}
              size="sm"
            />
          </cf-hstack>
          <cf-button
            color="primary"
            variant="solid"
            disabled={computed(() => !hasProfile)}
            onClick={() => {
              boundCreate.send({
                title: titleDraft.get(),
                dateTime: dateTimeDraft.get(),
                location: locationDraft.get(),
              });
              titleDraft.set("");
              dateTimeDraft.set("");
              locationDraft.set("");
            }}
          >
            Create event
          </cf-button>
        </cf-vstack>
      </cf-card>
    );

    // ----- Event view (shown once the event exists). The "You are"
    // <cf-profile-badge> and the note <cf-input $value> are STATIC here; only
    // their reactive siblings (join button, status buttons, guest counter,
    // headcount, roster) live in computed()/ifElse subtrees. -----
    const eventView = (
      <cf-vstack gap="4">
        {/* ===== Event header ===== */}
        <cf-card>
          <cf-vstack gap="2">
            <cf-heading level={2}>{event.title}</cf-heading>
            <cf-text tone="muted">
              {computed(() => {
                const when = trimmed(event.dateTime);
                const where = trimmed(event.location);
                return [when, where].filter((s) => s !== "").join(" · ");
              })}
            </cf-text>
            {
              /* Organizer = the profile SNAPSHOT of the creator. Shown with
                cf-avatar (snapshot only) — never cf-profile-badge, which is
                reserved for the current viewer. cf-avatar takes no `$`-binding,
                so reactive reads of event.organizer are fine here. */
            }
            <cf-hstack gap="2" align="center">
              <cf-text variant="caption" tone="muted">
                Hosted by
              </cf-text>
              <cf-avatar
                src={event.organizer.avatar}
                name={event.organizer.displayName}
                size="xs"
              />
              <cf-text variant="caption">
                {event.organizer.displayName}
              </cf-text>
            </cf-hstack>
          </cf-vstack>
        </cf-card>

        {/* ===== You (identity) ===== */}
        <cf-card>
          <cf-vstack gap="3">
            {
              /* The trusted badge shows WHO YOU ARE (live profile cell). STATIC
                position — `$profile` bound to the live wish result. The join
                button is a reactive sibling (no `$`-binding), so gating it in a
                computed is safe. */
            }
            <cf-hstack gap="3" align="center" wrap>
              <cf-label>You are</cf-label>
              <cf-profile-badge
                id="you-are-badge"
                $profile={profileWish.result}
                size="sm"
              />
              {computed(() =>
                isJoined ? null : (
                  <cf-button
                    color="primary"
                    variant="solid"
                    disabled={computed(() => !hasProfile)}
                    onClick={boundJoin}
                  >
                    RSVP with your profile
                  </cf-button>
                )
              )}
            </cf-hstack>

            {
              /* My RSVP status + guests — no `$`-bindings, so these may live in
                a computed gated on isJoined. They edit MY attendee row through
                the `me` reference. */
            }
            {computed(() =>
              isJoined
                ? (
                  <cf-vstack gap="2">
                    <cf-hstack gap="2" wrap align="center">
                      <cf-label>Your RSVP</cf-label>
                      {STATUS_ORDER.map((status) => (
                        <cf-button
                          variant={computed(() =>
                            me.attendee?.status === status ? "solid" : "ghost"
                          )}
                          color={status === "notgoing" ? "danger" : "primary"}
                          onClick={() => boundSetRsvp.send({ status })}
                        >
                          {STATUS_LABEL[status]}
                        </cf-button>
                      ))}
                    </cf-hstack>

                    <cf-hstack gap="2" align="center" wrap>
                      <cf-label>Extra guests</cf-label>
                      <cf-button
                        variant="ghost"
                        onClick={() =>
                          boundSetGuests.send({
                            guestCount: (me.attendee?.guestCount ?? 0) - 1,
                          })}
                      >
                        −
                      </cf-button>
                      <cf-text>
                        {computed(() => me.attendee?.guestCount ?? 0)}
                      </cf-text>
                      <cf-button
                        variant="ghost"
                        onClick={() =>
                          boundSetGuests.send({
                            guestCount: (me.attendee?.guestCount ?? 0) + 1,
                          })}
                      >
                        +
                      </cf-button>
                    </cf-hstack>
                  </cf-vstack>
                )
                : null
            )}

            {
              /* A note (optional) — the `$value` input is STATIC: it is rendered
                once and never regenerated inside a computed. Before joining it
                is disabled (reactive `disabled=` on a sibling prop is allowed),
                so the bidirectional binding stays at a fixed [UI] position
                regardless of join state. */
            }
            <cf-vstack gap="1">
              <cf-label>A note (optional)</cf-label>
              <cf-hstack gap="2" align="center">
                <cf-input
                  id="note-input"
                  $value={messageDraft}
                  placeholder="Bringing dessert!"
                  disabled={computed(() => !isJoined)}
                  style={{ flex: 1 }}
                />
                <cf-button
                  variant="solid"
                  disabled={computed(() => !isJoined)}
                  onClick={() => {
                    boundSetMessage.send({ message: messageDraft.get() });
                    messageDraft.set("");
                  }}
                >
                  Save note
                </cf-button>
              </cf-hstack>
              {computed(() =>
                isJoined ? null : (
                  <cf-text variant="caption" tone="muted">
                    RSVP above to add a note.
                  </cf-text>
                )
              )}
            </cf-vstack>
          </cf-vstack>
        </cf-card>

        {/* ===== Headcount (no `$`-bindings → computed content is fine) ===== */}
        <cf-card>
          <cf-hstack gap="3" align="center">
            <cf-badge color="accent">
              {computed(() => `${headcount} attending`)}
            </cf-badge>
            <cf-text tone="muted">
              {computed(() =>
                `${goingCount} ${goingCount === 1 ? "person" : "people"} going`
              )}
            </cf-text>
          </cf-hstack>
        </cf-card>

        {/* ===== Roster grouped by status (no `$`-bindings) ===== */}
        <cf-card>
          <cf-vstack gap="3">
            <cf-heading level={4}>Who's coming</cf-heading>
            {
              /* Derived array → wrap the .map in computed. Each group is a status
                section; OTHER attendees use cf-avatar + plain name. The viewer's
                own row is marked via the `me` reference using equals(), NOT name
                equality. None of these nodes carries a `$`-binding. */
            }
            {computed(() =>
              grouped.map((group) => (
                <cf-vstack gap="1">
                  <cf-text variant="caption" tone="muted">
                    {computed(() => `${group.label} (${group.people.length})`)}
                  </cf-text>
                  {group.people.map((a: Attendee) => (
                    <cf-hstack gap="2" align="center">
                      <cf-avatar
                        src={a.avatar}
                        name={a.displayName}
                        size="xs"
                      />
                      <span
                        style={{
                          fontWeight: computed(() =>
                            equals(me.attendee, a) ? "700" : "400"
                          ),
                        }}
                      >
                        {computed(() =>
                          equals(me.attendee, a)
                            ? `${a.displayName} (you)`
                            : a.displayName
                        )}
                      </span>
                      {computed(() =>
                        (a.guestCount || 0) > 0
                          ? (
                            <cf-badge color="neutral">
                              {`+${a.guestCount}`}
                            </cf-badge>
                          )
                          : null
                      )}
                      {computed(() =>
                        trimmed(a.message) !== ""
                          ? (
                            <cf-text variant="caption" tone="muted">
                              {`“${a.message}”`}
                            </cf-text>
                          )
                          : null
                      )}
                    </cf-hstack>
                  ))}
                </cf-vstack>
              ))
            )}
            {computed(() =>
              attendees.length === 0
                ? (
                  <cf-text tone="muted">
                    No RSVPs yet — be the first!
                  </cf-text>
                )
                : null
            )}
          </cf-vstack>
        </cf-card>
      </cf-vstack>
    );

    return {
      [NAME]: "Event RSVP",
      // `[UI]` is a STATIC <cf-vstack>. The create/view switch is `ifElse(...)`
      // as a CHILD of that static wrapper (never the `[UI]` value itself, and
      // never a `computed(() => …)` that regenerates a `$`-bound control). Both
      // branches are pre-built static subtrees, so every `$value` / `$profile`
      // binding inside them was constructed once at build time.
      [UI]: (
        <cf-vstack gap="4" style={{ padding: "1rem", maxWidth: "640px" }}>
          {ifElse(eventCreated, eventView, createForm)}
        </cf-vstack>
      ),

      // Shared event + roster + per-user pointer (re-exported for cross-piece
      // reads) plus derived headcounts.
      event,
      attendees,
      me,
      goingCount,
      headcount,
      createEvent: boundCreate,
      joinWithProfile: boundJoin,
      setRsvp: boundSetRsvp,
      setGuests: boundSetGuests,
      setMessage: boundSetMessage,
    };
  },
);
