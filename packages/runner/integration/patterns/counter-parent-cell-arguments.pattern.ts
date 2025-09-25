/// <cts-enable />
import { type Cell, Default, handler, lift, recipe, str } from "commontools";

const sanitizeCount = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.trunc(value);
};

const sanitizeStep = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  const whole = Math.trunc(value);
  if (whole === 0) return 1;
  return Math.abs(whole);
};

const resolveDelta = (amount: number | undefined, fallback: number): number => {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return fallback;
  const whole = Math.trunc(amount);
  if (whole === 0) return fallback;
  return whole;
};

const incrementShared = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number>; step: Cell<number> },
  ) => {
    const step = sanitizeStep(context.step.get());
    const delta = resolveDelta(event?.amount, step);
    const current = sanitizeCount(context.value.get());
    context.value.set(current + delta);
  },
);

const setSharedValue = handler(
  (
    event: { value?: number } | number | undefined,
    context: { value: Cell<number> },
  ) => {
    const candidate = typeof event === "number"
      ? event
      : typeof event?.value === "number"
      ? event.value
      : undefined;
    context.value.set(sanitizeCount(candidate));
  },
);

const updateSharedStep = handler(
  (
    event: { step?: number } | number | undefined,
    context: { step: Cell<number> },
  ) => {
    const candidate = typeof event === "number"
      ? event
      : typeof event?.step === "number"
      ? event.step
      : undefined;
    context.step.set(sanitizeStep(candidate));
  },
);

interface LinkedChildArgs {
  sharedValue: Default<number, 0>;
  sharedStep: Default<number, 1>;
}

const childLinkedCounter = recipe<LinkedChildArgs>(
  "Child Counter Referencing Parent Cells",
  ({ sharedValue, sharedStep }) => {
    const current = lift(sanitizeCount)(sharedValue);
    const step = lift(sanitizeStep)(sharedStep);
    const nextPreview = lift(
      (state: { current: number; step: number }) => state.current + state.step,
    )({
      current,
      step,
    });
    const parity = lift((value: number) => value % 2 === 0 ? "even" : "odd")(
      current,
    );
    const label = str`Child sees ${current} (step ${step}) [${parity}]`;

    return {
      current,
      step,
      parity,
      nextPreview,
      label,
      increment: incrementShared({ value: sharedValue, step: sharedStep }),
      setAbsolute: setSharedValue({ value: sharedValue }),
    };
  },
);

interface ParentCellArgumentArgs {
  value: Default<number, 0>;
  step: Default<number, 1>;
}

export const counterWithParentCellArguments = recipe<ParentCellArgumentArgs>(
  "Counter With Parent Cell Arguments",
  ({ value, step }) => {
    const current = lift(sanitizeCount)(value);
    const stepSize = lift(sanitizeStep)(step);
    const parentPreview = lift(
      (state: { current: number; step: number }) => state.current + state.step,
    )({
      current,
      step: stepSize,
    });

    const child = childLinkedCounter({
      sharedValue: value,
      sharedStep: step,
    });

    const alignment = lift(
      (state: { parent: number; child: number }) =>
        state.parent === state.child,
    )({
      parent: current,
      child: child.key("current"),
    });

    const sharedLabel = str`Parent ${current} child ${child.key("current")}`;

    return {
      value,
      step,
      current,
      stepSize,
      parentPreview,
      alignment,
      sharedLabel,
      child,
      increment: incrementShared({ value, step }),
      setAbsolute: setSharedValue({ value }),
      setStep: updateSharedStep({ step }),
    };
  },
);
