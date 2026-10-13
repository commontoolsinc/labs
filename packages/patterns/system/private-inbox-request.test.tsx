/**
 * Pattern tests for a request for Home's private inbox: `requestPrivateInbox`
 * has Home ensure its inbox, and `PrivateInboxAnswerer`, which that handler
 * returns as its answer, says where the request stands for the profile it
 * names. A pattern test cannot read a handling's receipt, so each answer here
 * is the answerer instantiated over the same holder and profiles a request
 * reads; the receipt itself is read in
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
import ProfileHome from "./profile-home.tsx";
import PrivateInbox, {
  ensurePrivateInbox,
  pointProfilesAtPrivateInbox,
  type PointTarget,
  type PrivateInboxAnswer,
  PrivateInboxAnswerer,
  privateInboxAnswerOf,
  type PrivateInboxHolder,
  type PrivateInboxPiece,
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

/** Creates an inbox and keeps it in `holder`, in the calling space. */
const holdNewInbox = handler<void, { holder: Writable<PrivateInboxHolder> }>(
  (_event, { holder }) => {
    holder.set({ piece: linkOf(PrivateInbox({ offers: [] })) });
  },
);

/**
 * Stands in for Home's request for its inbox: Home's `requestPrivateInbox`
 * over a holder and a profile list, sending Home's `ensurePrivateInbox`, with
 * its pointing step, over the same.
 */
const RequestingHome = pattern<
  {
    privateInbox: Writable<PrivateInboxHolder>;
    profiles: PointTarget[];
  },
  { request: Stream<PrivateInboxRequest, PrivateInboxAnswer> }
>(({ privateInbox, profiles }) => ({
  request: requestPrivateInbox({
    privateInbox,
    // deno-lint-ignore no-explicit-any
    profiles: profiles as any,
    ensure: ensurePrivateInbox({
      privateInbox,
      retainedPrivateInboxes: new Writable<RetainedPrivateInboxes>([]),
      privateInboxRefusal: new Writable<PrivateInboxRefusalHolder>({}),
      profiles,
      pointProfiles: pointProfilesAtPrivateInbox({ privateInbox, profiles }),
    }),
  }),
}));

export default pattern(() => {
  // A Home holding no inbox, with two profiles pointing at none, and a
  // profile outside its list.
  const first = ProfileHome({ initialName: "First" });
  const second = ProfileHome({ initialName: "Second" });
  const outsider = ProfileHome({ initialName: "Outsider" });
  const held = new Writable<PrivateInboxHolder>({});
  // deno-lint-ignore no-explicit-any
  const listed = [first, second] as any;
  const home = RequestingHome({ privateInbox: held, profiles: listed });
  // deno-lint-ignore no-explicit-any
  const answerFirst = PrivateInboxAnswerer({
    privateInbox: held,
    profile: first as any,
  });
  const answerSecond = PrivateInboxAnswerer({
    privateInbox: held,
    // deno-lint-ignore no-explicit-any
    profile: second as any,
  });

  // A Home whose one profile points at an inbox Home does not hold.
  const advertising = ProfileHome({ initialName: "Advertising" });
  const elsewhere = new Writable<PrivateInboxHolder>({});
  const holdElsewhere = holdNewInbox({ holder: elsewhere });
  const unheld = new Writable<PrivateInboxHolder>({});
  // deno-lint-ignore no-explicit-any
  const advertisingList = [advertising] as any;
  const advertisingHome = RequestingHome({
    privateInbox: unheld,
    profiles: advertisingList,
  });

  // A Home holding no inbox, whose first profile points at none while its
  // second advertises an inbox the host has not vetted.
  const waiting = ProfileHome({ initialName: "Waiting" });
  const unvetted = ProfileHome({ initialName: "Unvetted" });
  const awaitingVetting = new Writable<PrivateInboxHolder>({});
  // deno-lint-ignore no-explicit-any
  const awaitingList = [waiting, unvetted] as any;
  const awaitingHome = RequestingHome({
    privateInbox: awaitingVetting,
    profiles: awaitingList,
  });

  // A Home that holds an inbox it has not pointed its profile at yet.
  const unpointed = ProfileHome({ initialName: "Unpointed" });
  const holding = new Writable<PrivateInboxHolder>({});
  const holdInbox = holdNewInbox({ holder: holding });
  const pointHolding = pointProfilesAtPrivateInbox({
    privateInbox: holding,
    // deno-lint-ignore no-explicit-any
    profiles: [unpointed] as any,
  });
  const answerUnpointed = PrivateInboxAnswerer({
    privateInbox: holding,
    // deno-lint-ignore no-explicit-any
    profile: unpointed as any,
  });

  // A Home with no profiles at all.
  const lone = ProfileHome({ initialName: "Lone" });
  const profileless = new Writable<PrivateInboxHolder>({});
  const profilelessHome = RequestingHome({
    privateInbox: profileless,
    profiles: [],
  });

  const assert_a_profile_home_is_to_point_is_pending = assert(() =>
    privateInboxAnswerOf(held.get().piece, listed, first as never).status ===
      "pending" &&
    answerFirst.status === "pending" && answerSecond.status === "pending"
  );
  const assert_a_profile_outside_the_list_is_unlisted = assert(() =>
    privateInboxAnswerOf(held.get().piece, listed, outsider as never).status ===
      "unlisted"
  );
  const assert_a_request_naming_no_profile_is_unlisted = assert(() =>
    privateInboxAnswerOf(held.get().piece, listed, undefined).status ===
      "unlisted"
  );

  const action_hold_an_inbox = action(() => {
    holdInbox.send();
  });
  const assert_a_held_inbox_the_profile_does_not_point_at_is_pending = assert(
    () =>
      holding.get().piece !== undefined && answerUnpointed.status === "pending",
  );
  const action_point_the_unpointed_profile = action(() => {
    pointHolding.send();
  });
  const assert_the_answer_follows_the_pointer_to_the_held_inbox = assert(() =>
    answerUnpointed.status === "ensured" &&
    equals(answerUnpointed.inbox, holding.get().piece) &&
    equals(unpointed.inbox?.piece, holding.get().piece)
  );

  const action_advertise_elsewhere = action(() => {
    holdElsewhere.send();
  });
  const action_point_advertising_elsewhere = action(() => {
    advertising.setInbox.send({
      inbox: elsewhere.get().piece?.resolveAsCell(),
    });
    unvetted.setInbox.send({ inbox: elsewhere.get().piece?.resolveAsCell() });
  });

  // Two requests at once, as from two clients.
  const action_request = action(() => {
    home.request.send({ from: first });
    home.request.send({ from: second });
    advertisingHome.request.send({ from: advertising });
    awaitingHome.request.send({ from: waiting });
    profilelessHome.request.send({ from: lone });
  });

  const assert_the_answer_names_the_inbox_the_profile_points_at = assert(
    () =>
      answerFirst.status === "ensured" && held.get().piece !== undefined &&
      equals(answerFirst.inbox, held.get().piece) &&
      equals(first.inbox?.piece, held.get().piece) &&
      privateInboxAnswerOf(held.get().piece, listed, first as never).status ===
        "ensured",
  );
  const assert_two_requests_answer_one_inbox = assert(() =>
    answerSecond.status === "ensured" &&
    equals(answerSecond.inbox, answerFirst.inbox) &&
    equals(second.inbox?.piece, first.inbox?.piece)
  );
  const assert_a_profile_outside_the_list_is_not_pointed = assert(() =>
    outsider.inbox?.piece === undefined
  );
  const assert_a_profile_advertising_another_inbox_is_not_held = assert(() =>
    privateInboxAnswerOf(
        unheld.get().piece,
        advertisingList,
        advertising as never,
      )
        .status === "not-held" &&
    unheld.get().piece === undefined &&
    equals(advertising.inbox?.piece, elsewhere.get().piece)
  );
  const assert_a_profile_home_will_not_point_is_not_held = assert(() =>
    privateInboxAnswerOf(
        awaitingVetting.get().piece,
        awaitingList,
        waiting as never,
      )
        .status === "not-held" &&
    awaitingVetting.get().piece === undefined &&
    waiting.inbox?.piece === undefined
  );
  const assert_a_home_without_profiles_creates_its_inbox_and_answers_unlisted =
    assert(() =>
      privateInboxAnswerOf(profileless.get().piece, [], lone as never)
          .status ===
        "unlisted" &&
      profileless.get().piece !== undefined && lone.inbox?.piece === undefined
    );

  return {
    [TESTS]: [
      { assertion: assert_a_profile_home_is_to_point_is_pending },
      { assertion: assert_a_profile_outside_the_list_is_unlisted },
      { assertion: assert_a_request_naming_no_profile_is_unlisted },
      { action: action_hold_an_inbox },
      {
        assertion: assert_a_held_inbox_the_profile_does_not_point_at_is_pending,
      },
      { action: action_point_the_unpointed_profile },
      { assertion: assert_the_answer_follows_the_pointer_to_the_held_inbox },
      { action: action_advertise_elsewhere },
      { action: action_point_advertising_elsewhere },
      { action: action_request },
      { assertion: assert_the_answer_names_the_inbox_the_profile_points_at },
      { assertion: assert_two_requests_answer_one_inbox },
      { assertion: assert_a_profile_outside_the_list_is_not_pointed },
      { assertion: assert_a_profile_advertising_another_inbox_is_not_held },
      { assertion: assert_a_profile_home_will_not_point_is_not_held },
      {
        assertion:
          assert_a_home_without_profiles_creates_its_inbox_and_answers_unlisted,
      },
    ],
  };
});
