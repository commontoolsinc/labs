import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createInitialRunGate } from "../../src/scheduler/initial-run-gate.ts";

describe("createInitialRunGate", () => {
  it("notifies pending and later subscribers when released", () => {
    const controller = createInitialRunGate();
    const notifications: string[] = [];
    const unsubscribe = controller.gate.onRelease(() => {
      notifications.push("removed release");
    });
    unsubscribe();
    controller.gate.onRelease(() => notifications.push("release"));
    controller.gate.onSettle((status) => notifications.push(status));

    controller.release();
    controller.cancel();
    controller.gate.onRelease(() => notifications.push("late release"));
    controller.gate.onSettle((status) => notifications.push(`late ${status}`));

    expect(controller.gate.isReleased()).toBe(true);
    expect(controller.gate.status()).toBe("released");
    expect(notifications).toEqual([
      "released",
      "release",
      "late release",
      "late released",
    ]);
  });

  it("notifies settlement subscribers but not release subscribers when cancelled", () => {
    const controller = createInitialRunGate();
    const notifications: string[] = [];
    controller.gate.onRelease(() => notifications.push("release"));
    controller.gate.onSettle((status) => notifications.push(status));

    controller.cancel();
    controller.release();
    controller.gate.onRelease(() => notifications.push("late release"));
    controller.gate.onSettle((status) => notifications.push(`late ${status}`));

    expect(controller.gate.isReleased()).toBe(false);
    expect(controller.gate.status()).toBe("cancelled");
    expect(notifications).toEqual(["cancelled", "late cancelled"]);
  });

  it("runs every release and settlement callback before reporting failures", () => {
    const controller = createInitialRunGate();
    const notifications: string[] = [];
    controller.gate.onSettle(() => {
      throw new Error("settlement failed");
    });
    controller.gate.onSettle(() => notifications.push("settled"));
    controller.gate.onRelease(() => {
      throw new Error("release failed");
    });
    controller.gate.onRelease(() => notifications.push("released"));

    expect(() => controller.release()).toThrow(
      "Multiple initial-run gate callbacks failed",
    );
    expect(notifications).toEqual(["settled", "released"]);
    expect(controller.gate.status()).toBe("released");
  });

  it("reports one cancellation callback failure directly", () => {
    const controller = createInitialRunGate();
    const failure = new Error("cancellation failed");
    controller.gate.onSettle(() => {
      throw failure;
    });

    expect(() => controller.cancel()).toThrow(failure);
    expect(controller.gate.status()).toBe("cancelled");
  });

  it("combines multiple cancellation callback failures", () => {
    const controller = createInitialRunGate();
    controller.gate.onSettle(() => {
      throw new Error("first cancellation failed");
    });
    controller.gate.onSettle(() => {
      throw new Error("second cancellation failed");
    });

    expect(() => controller.cancel()).toThrow(
      "Multiple initial-run gate callbacks failed",
    );
  });
});
