/// <cts-enable />
/**
 * Minimal reproduction of the parking-coordinator test timeout.
 *
 * This test isolates the exact failure: adding a spot via .push() followed by
 * editing a different spot via .set(toSpliced()) causes a timeout.
 *
 * - "add then edit" → FAILS (timeout)
 * - "edit only" → passes
 * - "edit then add" → passes
 *
 * See FINDINGS.md for full analysis.
 */
import { action, computed, pattern } from "commontools";
import ParkingCoordinator, {
  INITIAL_SPOTS,
  type ParkingSpot,
} from "./main.tsx";

export default pattern(() => {
  const subject = ParkingCoordinator({
    spots: INITIAL_SPOTS,
    persons: [],
    requests: [],
    priorityOrder: [],
  });

  const add_spot_7 = action(() => {
    subject.addSpot.send({ number: "7", label: "Near entrance", notes: "" });
  });

  const edit_spot_1 = action(() => {
    const spot = subject.spots.find((s: ParkingSpot) => s.number === "1");
    if (spot) {
      subject.editSpot.send({
        spotId: spot.id,
        label: "Covered",
        notes: "Near lobby",
      });
    }
  });

  const has_4_spots = computed(() => {
    return subject.spots.filter(() => true).length === 4;
  });

  const spot_1_covered = computed(() => {
    const spot = subject.spots.find((s: ParkingSpot) => s.number === "1");
    return (spot?.label as string) === "Covered";
  });

  return {
    tests: [
      { action: add_spot_7 },
      { assertion: has_4_spots },
      { action: edit_spot_1 },
      { assertion: spot_1_covered },
    ],
  };
});
