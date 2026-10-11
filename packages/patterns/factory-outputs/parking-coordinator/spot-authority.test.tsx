/**
 * Parking Coordinator — who may write the spot list
 *
 * The spot list names the one handler that may modify it,
 * `commitParkingSpotChange`, which every spot action goes through. These
 * tests cover a parking admin changing spots through it, code the list does
 * not name writing the list (on a fresh piece and after an admin's change),
 * and a spot list stored before the list named its writer.
 *
 * A refused write is reported as a CFC policy warning, which is why console
 * warnings are allowed.
 */
import {
  action,
  type AddIntegrity,
  assert,
  handler,
  pattern,
  type RequiresIntegrity,
  TESTS,
  Writable,
} from "commonfabric";
import ParkingCoordinator, {
  DEFAULT_SPOTS,
  PARKING_ADMIN_INTEGRITY,
} from "./main.tsx";
import type { ParkingProfile, ParkingSpot } from "./main.tsx";

/** What `overwriteSpots` is bound to. */
interface OverwriteState {
  spots: Writable<MintingSpotList>;
}

/**
 * The spot list's shape with the list's own endorsement minted on the write,
 * which is all its floor asks for.
 */
type MintingSpotList = AddIntegrity<
  ParkingSpot[],
  readonly [typeof PARKING_ADMIN_INTEGRITY]
>;

/**
 * A handler the list does not name. Its write mints the endorsement the
 * list's floor requires, so only the list's writer contract can refuse it.
 */
const overwriteSpots = handler<void, OverwriteState>((_, { spots }) => {
  spots.set(
    [{
      spotNumber: "666",
      label: "Taken",
      notes: "",
      active: true,
    }] as MintingSpotList,
  );
});

/**
 * The spot list as it was stored before it named its writer: the floor and
 * the mint that satisfies it, and no writer.
 */
type LegacySpotList = RequiresIntegrity<
  AddIntegrity<ParkingSpot[], readonly [typeof PARKING_ADMIN_INTEGRITY]>,
  readonly [typeof PARKING_ADMIN_INTEGRITY]
>;

const spotNumbers = (spots: readonly ParkingSpot[]): string =>
  spots.map((spot) => spot.spotNumber).join(",");

export default pattern(() => {
  // ============================================================
  // Subject 1: a fresh piece's spot list
  // ============================================================

  const aliceProfile = Writable.of<ParkingProfile>({ name: "Alice" });
  const lot = ParkingCoordinator({
    people: [{
      profile: aliceProfile,
      name: "Alice",
      email: "alice@co.com",
      commuteMode: "drive",
      spotPreferences: [],
      defaultSpot: "",
      priorityRank: 1,
    }],
    requests: [],
    viewer: { name: "Alice", profile: aliceProfile },
  });
  const overwriteFresh = overwriteSpots({ spots: lot.spots as never });

  const action_enable_manager = action(() => lot.enableAdminManager.send());
  const action_bootstrap_alice = action(() =>
    lot.togglePersonAdmin.send({ profile: aliceProfile })
  );
  const action_add_spot7 = action(() =>
    lot.addSpot.send({ spotNumber: "7", label: "Level 2", notes: "" })
  );
  const action_edit_spot7 = action(() =>
    lot.editSpot.send({
      originalNumber: "7",
      spotNumber: "8",
      label: "Level 2",
      notes: "",
      active: true,
    })
  );
  const action_remove_spot1 = action(() =>
    lot.removeSpot.send({ spotNumber: "1" })
  );

  const assert_fresh_default = assert(() =>
    spotNumbers(lot.spots) === "1,5,12"
  );
  const assert_fresh_overwrite_refused = assert(() =>
    spotNumbers(lot.spots) === "1,5,12"
  );
  const assert_admin_added = assert(() =>
    spotNumbers(lot.spots) === "1,5,12,7"
  );
  const assert_admin_edited = assert(() =>
    spotNumbers(lot.spots) === "1,5,12,8"
  );
  const assert_admin_removed = assert(() =>
    spotNumbers(lot.spots) === "5,12,8"
  );
  const assert_overwrite_after_admin_refused = assert(() =>
    spotNumbers(lot.spots) === "5,12,8"
  );

  // ============================================================
  // Subject 2: a spot list stored before the list named its writer
  // ============================================================

  // The list keeps loading, and an admin's change takes the list's writer
  // contract with it: from then on, code the list does not name is refused.
  const bobProfile = Writable.of<ParkingProfile>({ name: "Bob" });
  const legacySpots = Writable.of<LegacySpotList>(
    DEFAULT_SPOTS as LegacySpotList,
  );
  const legacyLot = ParkingCoordinator({
    spots: legacySpots as never,
    people: [{
      profile: bobProfile,
      name: "Bob",
      email: "bob@co.com",
      commuteMode: "drive",
      spotPreferences: [],
      defaultSpot: "",
      priorityRank: 1,
    }],
    requests: [],
    viewer: { name: "Bob", profile: bobProfile },
  });
  const overwriteLegacy = overwriteSpots({ spots: legacySpots as never });

  const action_legacy_enable_manager = action(() =>
    legacyLot.enableAdminManager.send()
  );
  const action_legacy_bootstrap_bob = action(() =>
    legacyLot.togglePersonAdmin.send({ profile: bobProfile })
  );
  const action_legacy_add_spot9 = action(() =>
    legacyLot.addSpot.send({ spotNumber: "9", label: "", notes: "" })
  );

  const assert_legacy_loads = assert(() =>
    spotNumbers(legacyLot.spots) === "1,5,12"
  );
  const assert_legacy_admin_added = assert(() =>
    spotNumbers(legacyLot.spots) === "1,5,12,9"
  );
  const assert_legacy_overwrite_refused = assert(() =>
    spotNumbers(legacyLot.spots) === "1,5,12,9"
  );

  return {
    allowConsoleWarnings: true,
    [TESTS]: [
      // Subject 1
      { assertion: assert_fresh_default },
      { action: overwriteFresh },
      { assertion: assert_fresh_overwrite_refused },
      { action: action_enable_manager },
      { assertion: assert(() => lot.currentUserCanManageAdmins === true) },
      { action: action_bootstrap_alice },
      { assertion: assert(() => lot.currentPersonIsAdmin === true) },
      { action: action_add_spot7 },
      { assertion: assert_admin_added },
      { action: action_edit_spot7 },
      { assertion: assert_admin_edited },
      { action: action_remove_spot1 },
      { assertion: assert_admin_removed },
      { action: overwriteFresh },
      { assertion: assert_overwrite_after_admin_refused },

      // Subject 2
      { assertion: assert_legacy_loads },
      { action: action_legacy_enable_manager },
      {
        assertion: assert(() => legacyLot.currentUserCanManageAdmins === true),
      },
      { action: action_legacy_bootstrap_bob },
      { assertion: assert(() => legacyLot.currentPersonIsAdmin === true) },
      { action: action_legacy_add_spot9 },
      { assertion: assert_legacy_admin_added },
      { action: overwriteLegacy },
      { assertion: assert_legacy_overwrite_refused },
    ],
  };
});
