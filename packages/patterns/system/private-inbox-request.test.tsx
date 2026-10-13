/**
 * Pattern tests for a request for Home's private inbox: `requestPrivateInbox`
 * has Home ensure its inbox, and Home's answer for each profile, which
 * `privateInboxAnswersOf()` computes and a request's receipt links to, says
 * where a request naming that profile stands. A pattern test cannot read a
 * handling's receipt, so each case reads the answers a stand-in Home computes;
 * the receipt itself is read in
 * `packages/patterns/integration/private-inbox-multi-runtime.test.ts`.
 */

import {
  action,
  assert,
  type Cell,
  equals,
  handler,
  pattern,
  type Stream,
  TESTS,
  Writable,
} from "commonfabric";
import ProfileHome, { type ProfileInbox } from "./profile-home.tsx";
import PrivateInbox, {
  ensurePrivateInbox,
  pointProfilesAtPrivateInbox,
  type PointTarget,
  PrivateInboxAnswering,
  type PrivateInboxAnswers,
  type PrivateInboxHolder,
  type PrivateInboxPiece,
  type PrivateInboxReceipt,
  type PrivateInboxRefusalHolder,
  type PrivateInboxRequest,
  requestPrivateInbox,
  type RetainedPrivateInboxes,
} from "./private-inbox.tsx";

/** An inbox's result, as the link a holder keeps. */
function linkOf(inbox: unknown): Cell<PrivateInboxPiece>;
function linkOf(inbox: unknown): unknown {
  return inbox;
}

/** Creates an inbox in the calling space and keeps it in `holder`. */
const holdNewInbox = handler<void, { holder: Writable<PrivateInboxHolder> }>(
  (_event, { holder }) => {
    holder.set({ piece: linkOf(PrivateInbox({ offers: [] })) });
  },
);

/** Creates an inbox in a space of its own and keeps it in `holder`. */
const holdInboxElsewhere = handler<
  void,
  { holder: Writable<PrivateInboxHolder> }
>((_event, { holder }) => {
  holder.set({
    piece: linkOf(PrivateInbox.inSpace("elsewhere-inbox")({ offers: [] })),
  });
});

/** Points a stand-in profile's pointer where the event says. */
const setStandInInbox = handler<
  { inbox?: Cell<PrivateInboxPiece> },
  { inbox: Writable<ProfileInbox> }
>((event, { inbox }) => {
  inbox.set(event.inbox === undefined ? {} : { piece: event.inbox });
});

/** Stands in for a profile of a vintage with a pointer and no `setInbox`. */
const NoSetInboxProfile = pattern<
  Record<never, never>,
  { inbox: ProfileInbox; pointAt: Stream<{ inbox?: Cell<PrivateInboxPiece> }> }
>(() => {
  const inbox = new Writable<ProfileInbox>({}).for("inbox");
  // The test points it through a stream under another name, which Home does
  // not know to send.
  return { inbox, pointAt: setStandInInbox({ inbox }) };
});

/**
 * Stands in for Home's request for its inbox: Home's `requestPrivateInbox`
 * over a profile list and the answers Home computes for it, sending Home's
 * `ensurePrivateInbox`, with its pointing step, over the same.
 */
const RequestingHome = pattern<
  {
    privateInbox: Writable<PrivateInboxHolder>;
    profiles: PointTarget[];
  },
  {
    request: Stream<PrivateInboxRequest, PrivateInboxReceipt>;
    answers: PrivateInboxAnswers;
  }
>(({ privateInbox, profiles }) => {
  const { answers } = PrivateInboxAnswering({ privateInbox, profiles });
  return {
    request: requestPrivateInbox({
      profiles,
      answers,
      ensure: ensurePrivateInbox({
        privateInbox,
        retainedPrivateInboxes: new Writable<RetainedPrivateInboxes>([]),
        privateInboxRefusal: new Writable<PrivateInboxRefusalHolder>({}),
        profiles,
        pointProfiles: pointProfilesAtPrivateInbox({ privateInbox, profiles }),
      }),
    }),
    answers,
  };
});

export default pattern(() => {
  // A Home holding no inbox, with two profiles pointing at none.
  const first = ProfileHome({ initialName: "First" });
  const second = ProfileHome({ initialName: "Second" });
  const held = new Writable<PrivateInboxHolder>({});
  const home = RequestingHome({
    privateInbox: held,
    // deno-lint-ignore no-explicit-any
    profiles: [first, second] as any,
  });

  // A Home that holds an inbox it has not pointed its profiles at yet: the
  // first is pointed by Home, the second at an inbox in another space, the
  // third at another inbox in the space of the one Home holds, and the fourth
  // has no `setInbox`.
  const pointedByHome = ProfileHome({ initialName: "Pointed by Home" });
  const pointedElsewhere = ProfileHome({ initialName: "Pointed elsewhere" });
  const pointedNearby = ProfileHome({ initialName: "Pointed nearby" });
  const withoutSetInbox = NoSetInboxProfile({});
  const holding = new Writable<PrivateInboxHolder>({});
  const nearby = new Writable<PrivateInboxHolder>({});
  const elsewhere = new Writable<PrivateInboxHolder>({});
  const holdInbox = holdNewInbox({ holder: holding });
  const holdNearby = holdNewInbox({ holder: nearby });
  const holdElsewhere = holdInboxElsewhere({ holder: elsewhere });
  const holdingHome = RequestingHome({
    privateInbox: holding,
    profiles: [
      pointedByHome,
      pointedElsewhere,
      pointedNearby,
      withoutSetInbox,
      // deno-lint-ignore no-explicit-any
    ] as any,
  });
  const pointHolding = pointProfilesAtPrivateInbox({
    privateInbox: holding,
    // deno-lint-ignore no-explicit-any
    profiles: [pointedByHome] as any,
  });

  // A Home holding no inbox, whose one profile points at another inbox.
  const advertising = ProfileHome({ initialName: "Advertising" });
  const unheld = new Writable<PrivateInboxHolder>({});
  const advertisingHome = RequestingHome({
    privateInbox: unheld,
    // deno-lint-ignore no-explicit-any
    profiles: [advertising] as any,
  });

  // A Home holding no inbox, whose first profile points at none while its
  // second advertises an inbox the host has not vetted.
  const waiting = ProfileHome({ initialName: "Waiting" });
  const unvetted = ProfileHome({ initialName: "Unvetted" });
  const awaitingVetting = new Writable<PrivateInboxHolder>({});
  const awaitingHome = RequestingHome({
    privateInbox: awaitingVetting,
    // deno-lint-ignore no-explicit-any
    profiles: [waiting, unvetted] as any,
  });

  // A Home with no profiles at all.
  const lone = ProfileHome({ initialName: "Lone" });
  const profileless = new Writable<PrivateInboxHolder>({});
  const profilelessHome = RequestingHome({
    privateInbox: profileless,
    profiles: [],
  });

  const assert_profiles_home_is_to_point_are_pending = assert(() =>
    home.answers.profiles.length === 2 &&
    home.answers.profiles[0]?.status === "pending" &&
    home.answers.profiles[1]?.status === "pending"
  );

  const assert_requests_home_points_no_profile_for_have_answers_of_their_own =
    assert(() =>
      home.answers.unlisted.status === "unlisted" &&
      home.answers.unpointable.status === "unpointable"
    );

  const action_hold_the_inboxes = action(() => {
    holdInbox.send();
    holdNearby.send();
    holdElsewhere.send();
  });
  const assert_a_held_inbox_the_profile_does_not_point_at_is_pending = assert(
    () =>
      holding.get().piece !== undefined &&
      holdingHome.answers.profiles[0]?.status === "pending",
  );

  const action_point_the_profiles = action(() => {
    pointHolding.send();
    pointedElsewhere.setInbox.send({
      inbox: elsewhere.get().piece?.resolveAsCell(),
    });
    pointedNearby.setInbox.send({
      inbox: nearby.get().piece?.resolveAsCell(),
    });
    advertising.setInbox.send({
      inbox: elsewhere.get().piece?.resolveAsCell(),
    });
    unvetted.setInbox.send({ inbox: elsewhere.get().piece?.resolveAsCell() });
  });
  const assert_the_answer_follows_the_pointer_to_the_held_inbox = assert(() =>
    holdingHome.answers.profiles[0]?.status === "ensured" &&
    equals(pointedByHome.inbox?.piece, holding.get().piece)
  );
  const assert_a_profile_another_inbox_won_is_not_held = assert(() =>
    holdingHome.answers.profiles[1]?.status === "not-held" &&
    equals(pointedElsewhere.inbox?.piece, elsewhere.get().piece)
  );
  const assert_another_inbox_in_the_held_inbox_space_is_pending = assert(() =>
    holdingHome.answers.profiles[2]?.status === "pending"
  );

  // Two requests to the first Home, one after the other, as from two clients.
  // Each Home that creates its inbox is sent its requests in actions of its
  // own: two ensures in flight at once over a Home holding none commit across
  // spaces against each other, which the runtime logs as an error.
  // `private-inbox-multi-runtime.test.ts` sends two at once.
  const action_request_first = action(() => {
    home.request.send({ from: first });
  });
  const action_request_second = action(() => {
    home.request.send({ from: second });
  });
  const action_request_where_home_creates_none = action(() => {
    advertisingHome.request.send({ from: advertising });
    awaitingHome.request.send({ from: waiting });
  });
  const action_request_without_profiles = action(() => {
    profilelessHome.request.send({ from: lone });
  });

  const assert_a_request_is_ensured_once_home_points_its_profile = assert(
    () =>
      home.answers.profiles[0]?.status === "ensured" &&
      held.get().piece !== undefined &&
      equals(first.inbox?.piece, held.get().piece),
  );
  const assert_two_requests_end_at_one_inbox = assert(() =>
    home.answers.profiles[1]?.status === "ensured" &&
    equals(second.inbox?.piece, first.inbox?.piece)
  );
  const assert_a_profile_advertising_another_inbox_is_not_held = assert(() =>
    advertisingHome.answers.profiles[0]?.status === "not-held" &&
    unheld.get().piece === undefined
  );
  const assert_a_profile_home_will_not_point_is_not_held = assert(() =>
    awaitingHome.answers.profiles[0]?.status === "not-held" &&
    awaitingVetting.get().piece === undefined &&
    waiting.inbox?.piece === undefined
  );
  const assert_a_home_without_profiles_creates_its_inbox_and_answers_none =
    assert(() =>
      profilelessHome.answers.profiles.length === 0 &&
      profileless.get().piece !== undefined &&
      lone.inbox?.piece === undefined
    );

  return {
    [TESTS]: [
      { assertion: assert_profiles_home_is_to_point_are_pending },
      {
        assertion:
          assert_requests_home_points_no_profile_for_have_answers_of_their_own,
      },
      { action: action_hold_the_inboxes },
      {
        assertion: assert_a_held_inbox_the_profile_does_not_point_at_is_pending,
      },
      { action: action_point_the_profiles },
      { assertion: assert_the_answer_follows_the_pointer_to_the_held_inbox },
      { assertion: assert_a_profile_another_inbox_won_is_not_held },
      { assertion: assert_another_inbox_in_the_held_inbox_space_is_pending },
      { action: action_request_first },
      { action: action_request_second },
      { action: action_request_where_home_creates_none },
      { action: action_request_without_profiles },
      { assertion: assert_a_request_is_ensured_once_home_points_its_profile },
      { assertion: assert_two_requests_end_at_one_inbox },
      { assertion: assert_a_profile_advertising_another_inbox_is_not_held },
      { assertion: assert_a_profile_home_will_not_point_is_not_held },
      {
        assertion:
          assert_a_home_without_profiles_creates_its_inbox_and_answers_none,
      },
    ],
  };
});
