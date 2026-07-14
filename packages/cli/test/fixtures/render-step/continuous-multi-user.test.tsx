import {
  action,
  computed,
  multiUserTest,
  pattern,
  UI,
  Writable,
} from "commonfabric";
import { lateVDOMBranch } from "./subject.tsx";

const alice = pattern(() => {
  const phase = new Writable("initial");
  const advance = action(() => phase.set("late"));
  const view = (
    <div>
      {computed(() =>
        phase.get() === "late"
          ? <span>{computed(() => lateVDOMBranch())}</span>
          : null
      )}
    </div>
  );
  const isLate = computed(() => phase.get() === "late");

  return {
    [UI]: view,
    tests: [
      { action: advance },
      { assertion: isLate },
    ],
  };
});

export default multiUserTest({ participants: { alice } });
