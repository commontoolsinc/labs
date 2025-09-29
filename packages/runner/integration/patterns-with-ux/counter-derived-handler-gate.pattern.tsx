/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  compute,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

type GateMode = "enabled" | "disabled";

interface DerivedHandlerGateArgs {
  value: Default<number, 0>;
  gateMode: Default<GateMode, "enabled">;
}

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
      return;
    }

    const next = currentValue + amount;
    context.value.set(next);
    context.appliedCount.set(applied + 1);
    context.log.set([...history, `applied:${next}`]);
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

export const counterWithDerivedHandlerGateUx = recipe<DerivedHandlerGateArgs>(
  "Counter With Derived Handler Gate (UX)",
  ({ value, gateMode }) => {
    const attemptLog = cell<string[]>([]);
    const blockedCount = cell<number>(0);
    const appliedCount = cell<number>(0);

    const initialize = compute(() => {
      if (value.get() === undefined) {
        value.set(0);
      }
      const currentMode = gateMode.get();
      if (currentMode !== "enabled" && currentMode !== "disabled") {
        gateMode.set("enabled");
      }
    });

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

    const label = str`Count ${safeValue} (${statusLabel})`;
    const name = str`Handler Gate Counter (${safeValue})`;

    const gateStatusStyle = lift((active: boolean) =>
      active
        ? "background: linear-gradient(135deg, #10b981, #059669); color: white; border: 2px solid #059669;"
        : "background: linear-gradient(135deg, #ef4444, #dc2626); color: white; border: 2px solid #dc2626;"
    )(isActive);

    const gateIconStyle = lift((active: boolean) =>
      active
        ? "display: inline-block; width: 0.75rem; height: 0.75rem; background: #dcfce7; border-radius: 50%; margin-right: 0.5rem;"
        : "display: inline-block; width: 0.75rem; height: 0.75rem; background: #fee2e2; border-radius: 50%; margin-right: 0.5rem;"
    )(isActive);

    const historyDisplay = lift((entries: string[]) => {
      const recent = entries.slice(-8).reverse();
      if (recent.length === 0) {
        return (
          <div style="color: #94a3b8; font-style: italic; text-align: center; padding: 1rem;">
            No attempts yet
          </div>
        );
      }

      const items = recent.map((entry, idx) => {
        const isBlocked = entry.startsWith("blocked:");
        const displayText = entry.replace(/^(blocked|applied):/, "");
        const bgColor = isBlocked ? "#fee2e2" : "#dcfce7";
        const borderColor = isBlocked ? "#fca5a5" : "#86efac";
        const textColor = isBlocked ? "#991b1b" : "#166534";
        const label = isBlocked ? "Blocked" : "Applied";

        return (
          <div
            key={String(idx)}
            style={"display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0.75rem; background: " +
              bgColor + "; border-left: 3px solid " + borderColor +
              "; border-radius: 0.375rem;"}
          >
            <span style={"font-weight: 600; color: " + textColor + ";"}>
              {label}
            </span>
            <span style="font-family: monospace; color: #475569;">
              {displayText}
            </span>
          </div>
        );
      });

      return (
        <div style="display: flex; flex-direction: column; gap: 0.5rem;">
          {items}
        </div>
      );
    })(attemptHistory);

    const statsDisplay = lift(
      (stats: { blocked: number; applied: number }) => {
        const blocked = stats.blocked;
        const applied = stats.applied;
        const total = blocked + applied;
        const blockedPercent = total > 0 ? (blocked / total) * 100 : 0;
        const appliedPercent = total > 0 ? (applied / total) * 100 : 0;
        const appliedStr = String(applied);
        const blockedStr = String(blocked);
        const appliedPercentStr = String(appliedPercent.toFixed(0));
        const blockedPercentStr = String(blockedPercent.toFixed(0));

        return (
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;">
            <div style="background: #dcfce7; border-radius: 0.5rem; padding: 0.75rem; text-align: center;">
              <div style="font-size: 0.75rem; color: #166534; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.25rem;">
                Applied
              </div>
              <div style="font-size: 1.5rem; font-weight: 700; color: #15803d;">
                {appliedStr}
              </div>
              <div style="font-size: 0.7rem; color: #16a34a; margin-top: 0.25rem;">
                {appliedPercentStr}%
              </div>
            </div>
            <div style="background: #fee2e2; border-radius: 0.5rem; padding: 0.75rem; text-align: center;">
              <div style="font-size: 0.75rem; color: #991b1b; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.25rem;">
                Blocked
              </div>
              <div style="font-size: 1.5rem; font-weight: 700; color: #dc2626;">
                {blockedStr}
              </div>
              <div style="font-size: 0.7rem; color: #ef4444; margin-top: 0.25rem;">
                {blockedPercentStr}%
              </div>
            </div>
          </div>
        );
      },
    )({ blocked: blockedAttempts, applied: appliedAttempts });

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 40rem;
          ">
          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1.25rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.25rem;
                ">
                <span style="
                    color: #475569;
                    font-size: 0.75rem;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                  ">
                  Derived Handler Gate Pattern
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Gate controls whether increments are applied or blocked
                </h2>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
                <div style="
                    background: #f8fafc;
                    border-radius: 0.75rem;
                    padding: 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                  ">
                  <div style="
                      display: flex;
                      justify-content: space-between;
                      align-items: baseline;
                    ">
                    <span style="font-size: 0.8rem; color: #475569;">
                      Current value
                    </span>
                    <strong style="font-size: 2rem; color: #0f172a;">
                      {safeValue}
                    </strong>
                  </div>
                </div>

                <div
                  style={gateStatusStyle}
                  data-testid="gate-status"
                  role="status"
                  aria-live="polite"
                  style="
                    padding: 1rem;
                    border-radius: 0.75rem;
                    font-weight: 600;
                    text-align: center;
                    transition: all 0.3s ease;
                  "
                >
                  <div style="
                      display: flex;
                      align-items: center;
                      justify-content: center;
                    ">
                    <span style={gateIconStyle}></span>
                    <span>Gate: {statusLabel}</span>
                  </div>
                </div>

                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.75rem;
                  ">
                  <ct-button
                    onClick={toggleGate}
                    variant="secondary"
                    aria-label="Toggle gate"
                    data-testid="toggle-gate-button"
                  >
                    Toggle gate ({statusLabel})
                  </ct-button>

                  <ct-button
                    onClick={increment}
                    aria-label="Attempt increment"
                    data-testid="increment-button"
                  >
                    Attempt increment (+1)
                  </ct-button>
                </div>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Statistics
              </h3>
            </div>
            <div slot="content">
              {statsDisplay}
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Attempt history
              </h3>
            </div>
            <div slot="content">
              {historyDisplay}
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Pattern explanation
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.75rem;
                font-size: 0.9rem;
                color: #475569;
                line-height: 1.6;
              "
            >
              <p style="margin: 0;">
                This pattern demonstrates{" "}
                <strong>derived handler gating</strong>{" "}
                where a handler's behavior is controlled by a derived boolean
                state. When the gate is{" "}
                <strong>enabled</strong>, increment operations are applied to
                the counter. When{" "}
                <strong>
                  disabled
                </strong>, they are blocked and logged.
              </p>
              <p style="margin: 0;">
                The handler checks the{" "}
                <code style="
                    background: #f1f5f9;
                    padding: 0.125rem 0.375rem;
                    border-radius: 0.25rem;
                    font-family: monospace;
                  ">
                  canIncrement
                </code>{" "}
                derived boolean before applying changes, tracking both
                successful and blocked attempts in separate counters. This
                showcases conditional handler logic based on reactive state.
              </p>
            </div>
          </ct-card>

          <div
            role="status"
            aria-live="polite"
            data-testid="status"
            style="font-size: 0.85rem; color: #475569;"
          >
            {label}
          </div>
        </div>
      ),
      value,
      gateMode: safeGateMode,
      current: safeValue,
      isActive,
      status: statusLabel,
      blockedAttempts,
      appliedAttempts,
      attemptHistory,
      label,
      increment,
      toggleGate,
      effects: { initialize },
    };
  },
);

export default counterWithDerivedHandlerGateUx;
