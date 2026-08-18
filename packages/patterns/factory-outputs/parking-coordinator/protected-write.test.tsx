import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import ParkingCoordinator, {
  TRUSTED_PARKING_ADMIN_ACTION,
  TRUSTED_PARKING_ADMIN_SURFACE,
} from "./main.tsx";
import type {
  ParkingSpot,
  Person,
  SpotRequest,
  TrustedParkingSpotList,
} from "./main.tsx";

const ALICE: Person = {
  name: "Alice",
  email: "alice@example.test",
  commuteMode: "drive",
  spotPreferences: [],
  defaultSpot: "",
  priorityRank: 1,
};

export default pattern(() => {
  const spots = Writable.perSpace.of<TrustedParkingSpotList>(
    [] as TrustedParkingSpotList,
  );
  const people = Writable.perSpace.of<Person[]>([ALICE]);
  const requests = Writable.perSpace.of<SpotRequest[]>([]);
  const coordinator = ParkingCoordinator({
    spots: spots as never,
    people,
    requests,
  });
  const enableAdminManager = action(() =>
    coordinator.enableAdminManager.send()
  );
  const protectedSpotWasAdded = assert(() =>
    coordinator.spots.some((spot: ParkingSpot) => spot.spotNumber === "42")
  );

  return {
    [TESTS]: [
      { action: enableAdminManager },
      {
        action: coordinator.trustedTogglePersonAdmin,
        event: { name: "Alice" },
        trustedUi: {
          surface: TRUSTED_PARKING_ADMIN_SURFACE,
          action: TRUSTED_PARKING_ADMIN_ACTION,
        },
      },
      {
        action: coordinator.addSpot,
        event: {
          spotNumber: "42",
          label: "Protected spot",
          notes: "Added after the trusted administrator grant",
        },
      },
      { assertion: protectedSpotWasAdded },
    ],
  };
});
