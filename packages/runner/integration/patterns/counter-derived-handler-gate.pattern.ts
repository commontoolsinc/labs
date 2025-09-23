/// <cts-enable />
import {
  Cell,
  cell,
  createCell,
  Default,
  handler,
  lift,
  recipe,
  str,
} from "commontools";

type GateMode = "enabled" | "disabled";

interface DerivedHandlerGateArgs {
  value: Default<number, 0>;
  gateMode: Default<GateMode, "enabled">;
}

const attemptAuditSchema = {
  type: "object",
  additionalProperties: false,
  required: ["allowed", "amount", "value"],
  properties: {
    allowed: { type: "boolean" },
    amount: { type: "number" },
    value: { type: "number" },
  },
} as const;

const ensureNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const normalizeAmount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 1;

const clampGateMode = (value: unknown): GateMode =>
  value === "disabled" ? "disabled" : "enabled";

const applyIncrement = handler(
  (
    event: { amount?: number } | undefined,
    context: {
      value: Cell<number>;
      log: Cell<string[]>;
      blockedCount: Cell<number>;
      appliedCount: Cell<number>;
      canIncrement: Cell<boolean>;
    },
  ) => {
    const amount = normalizeAmount(event?.amount);
    const historyRaw = context.log.get();
    const history = Array.isArray(historyRaw) ? historyRaw : [];
    const allowed = context.canIncrement.get() === true;
    const currentValue = ensureNumber(context.value.get(), 0);
    const blocked = ensureNumber(context.blockedCount.get(), 0);
    const applied = ensureNumber(context.appliedCount.get(), 0);

    if (!allowed) {
      context.blockedCount.set(blocked + 1);
      context.log.set([...history, `blocked:${amount}`]);
      createCell(
        attemptAuditSchema,
        "counterDerivedHandlerGateAttempt",
        { allowed: false, amount, value: currentValue },
      );
      return;
    }

    const next = currentValue + amount;
    context.value.set(next);
    context.appliedCount.set(applied + 1);
    context.log.set([...history, `applied:${next}`]);
    createCell(
      attemptAuditSchema,
      "counterDerivedHandlerGateAttempt",
      { allowed: true, amount, value: next },
    );
  },
);

const setGateMode = handler(
  (
    event: { mode?: GateMode } | undefined,
    context: { gateMode: Cell<GateMode> },
  ) => {
    const current = clampGateMode(context.gateMode.get());
    const next = event?.mode === "disabled"
      ? "disabled"
      : event?.mode === "enabled"
      ? "enabled"
      : current === "enabled"
      ? "disabled"
      : "enabled";

    if (next !== current) {
      context.gateMode.set(next);
    }
  },
);

export const counterWithDerivedHandlerGate = recipe<DerivedHandlerGateArgs>(
  "Counter With Derived Handler Gate",
  ({ value, gateMode }) => {
    const attemptLog = cell<string[]>([]);
    const blockedCount = cell<number>(0);
    const appliedCount = cell<number>(0);

    const safeValue = lift((input: number | undefined) =>
      typeof input === "number" && Number.isFinite(input) ? input : 0
    )(value);

    const safeGateMode = lift((mode: GateMode | string | undefined) =>
      mode === "disabled" ? "disabled" : "enabled"
    )(gateMode);

    const isActive = lift((mode: GateMode) => mode === "enabled")(
      safeGateMode,
    );

    const statusLabel = lift((mode: GateMode) =>
      mode === "disabled" ? "disabled" : "enabled"
    )(safeGateMode);

    const attemptHistory = lift((entries: string[] | undefined) =>
      Array.isArray(entries) ? entries : []
    )(attemptLog);

    const blockedAttempts = lift((count: number | undefined) =>
      typeof count === "number" && Number.isFinite(count) ? count : 0
    )(blockedCount);

    const appliedAttempts = lift((count: number | undefined) =>
      typeof count === "number" && Number.isFinite(count) ? count : 0
    )(appliedCount);

    const increment = applyIncrement({
      value,
      log: attemptLog,
      blockedCount,
      appliedCount,
      canIncrement: isActive,
    });

    const toggleGate = setGateMode({ gateMode });

    return {
      value,
      gateMode: safeGateMode,
      current: safeValue,
      isActive,
      status: statusLabel,
      blockedAttempts,
      appliedAttempts,
      attemptHistory,
      label: str`Count ${safeValue} (${statusLabel})`,
      increment,
      toggleGate,
    };
  },
);
