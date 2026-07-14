import { action, computed, pattern, Writable } from "commonfabric";
import { lateVDOMBranch } from "./subject.tsx";

export default pattern(() => {
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
  void view;

  return {
    tests: [
      { action: advance },
      { assertion: isLate },
    ],
  };
});
