import { equal as assertEqual } from "node:assert/strict";
import { useCancelGroup } from "../cancel.js";

describe("useCancelGroup", () => {
  it("returns a pair of cancel and add", () => {
    const pair = useCancelGroup();

    const [cancel, addCancel] = pair;
    assertEqual(pair.length, 2);
    assertEqual(typeof cancel, "function");
    assertEqual(typeof addCancel, "function");
  });

  it("runs all cancels in group", () => {
    const pair = useCancelGroup();

    const [cancel, addCancel] = pair;

    let calls = 0;

    addCancel(() => calls++);
    addCancel(() => calls++);
    addCancel(() => calls++);

    cancel();

    assertEqual(calls, 3);
  });

  it("releases cancels after running them", () => {
    const pair = useCancelGroup();

    const [cancel, addCancel] = pair;

    let calls = 0;

    addCancel(() => calls++);

    cancel();
    cancel();
    cancel();

    assertEqual(calls, 1);
  });
});