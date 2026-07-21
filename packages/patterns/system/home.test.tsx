import { action, assert, NAME, pattern, Writable } from "commonfabric";
import Home from "./home.tsx";

export default pattern(() => {
  const home = Home({});

  // A stable piece cell to favorite and unfavorite by identity.
  const piece = new Writable<{ [NAME]?: string }>({ [NAME]: "Fav Piece" });

  const assert_initial_profile_missing = assert(() =>
    ((home.profiles as unknown[])?.length ?? 0) === 0
  );

  // NOTE: untrusted-write protection (sending the exported `createProfile`
  // stream from outside the trusted ProfileCreate surface must NOT create a
  // profile) is enforced by CFC and verified in
  // packages/runner/test/profile-owner-cfc.test.ts under `enforce-explicit`.
  // It can't be asserted here: the pattern-test runner runs CFC in `observe`
  // mode (no enforcement), so an untrusted send is not blocked. The previous
  // version of this test only "passed" because the untrusted cross-space
  // `inSpace` write incidentally threw a write-isolation error — which the
  // multi-profile change legitimately allows via a multi-space commit.

  // Favorites are keyed by the piece's identity (the client-supplied id): the
  // handler sets the keyed entity and add-uniques it.
  const action_add_favorite = action(() => {
    home.addFavorite.send({
      piece,
      tags: ["demo"],
      spaceName: "space-a",
      id: "fav-1",
    });
  });

  // The first removal takes the keyed path (the entity exists) and clears it.
  const action_remove_favorite = action(() => {
    home.removeFavorite.send({ piece, id: "fav-1" });
  });

  // A second removal with the same id finds no entity (it was cleared), so it
  // takes the piece-cell fallback that keeps a pre-keyed favorite deletable.
  const action_remove_favorite_again = action(() => {
    home.removeFavorite.send({ piece, id: "fav-1" });
  });

  // The journal append is an exported mergeable push.
  const action_add_journal = action(() => {
    home.addJournalEntry.send({
      entry: {
        timestamp: 1,
        eventType: "piece:created",
        space: "space-a",
      },
    });
  });

  // Spaces are keyed by name: the add sets the keyed entity and add-uniques it,
  // and the remove matches that identity via removeByValue.
  const action_add_space = action(() => {
    home.addSpace.send({ detail: { message: "Space One" } });
  });
  const action_remove_space = action(() => {
    home.removeSpace.send({ name: "Space One" });
  });

  return {
    tests: [
      { assertion: assert_initial_profile_missing },
      { action: action_add_favorite },
      { action: action_remove_favorite },
      { action: action_remove_favorite_again },
      { action: action_add_journal },
      { action: action_add_space },
      { action: action_remove_space },
      { assertion: assert_initial_profile_missing },
    ],
  };
});
