/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  Default,
  derive,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

interface CounterChecksumArgs {
  value: Default<number, 0>;
  values: Default<number[], []>;
  prefix: Default<string, "Checksum">;
}

interface ChecksumSnapshot {
  amount: number;
  nextValue: number;
  checksum: number;
}

interface ChecksumAudit {
  updates: number;
  checksum: number;
}

const normalizeNumber = (input: unknown): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return 0;
  }
  return Math.trunc(input);
};

const sanitizeNumbers = (input: unknown): number[] => {
  if (!Array.isArray(input)) {
    return [];
  }
  const sanitized: number[] = [];
  for (const item of input) {
    if (typeof item === "number" && Number.isFinite(item)) {
      sanitized.push(Math.trunc(item));
    }
  }
  return sanitized;
};

const computeChecksum = (numbers: readonly number[]): number => {
  let checksum = 0;
  for (let index = 0; index < numbers.length; index++) {
    const normalized = Math.abs(numbers[index]) & 0xff;
    const weight = (index % 7) + 1;
    checksum = (checksum + normalized * weight) % 65535;
  }
  return checksum;
};

const sanitizeSnapshot = (
  input: ChecksumSnapshot | undefined,
): ChecksumSnapshot => {
  if (!input) {
    return { amount: 0, nextValue: 0, checksum: 0 };
  }
  return {
    amount: normalizeNumber(input.amount),
    nextValue: normalizeNumber(input.nextValue),
    checksum: normalizeNumber(input.checksum),
  };
};

const sanitizeAudit = (input: ChecksumAudit | undefined): ChecksumAudit => {
  if (!input) {
    return { updates: 0, checksum: 0 };
  }
  return {
    updates: normalizeNumber(input.updates),
    checksum: normalizeNumber(input.checksum),
  };
};

const formatNumber = (value: number): string => {
  const safe = Number.isFinite(value) ? value : 0;
  return String(Math.trunc(safe));
};

const formatChecksum = (value: number): string => {
  const safe = Number.isFinite(value) ? value : 0;
  const hex = Math.trunc(safe).toString(16).toUpperCase().padStart(4, "0");
  return hex;
};

/** Pattern computing checksum of recorded counter values via derive. */
export const counterWithDerivedChecksumUx = recipe<CounterChecksumArgs>(
  "Counter With Derived Checksum (UX)",
  ({ value, values, prefix }) => {
    const updateCount = cell(0);

    const lastEvent = cell<ChecksumSnapshot>({
      amount: 0,
      nextValue: 0,
      checksum: 0,
    });
    const auditView = cell<ChecksumAudit>({
      updates: 0,
      checksum: 0,
    });

    const currentValue = lift((input: number | undefined) =>
      normalizeNumber(input)
    )(value);
    const valuesView = lift(sanitizeNumbers)(values);
    const checksum = derive(valuesView, computeChecksum);
    const checksumView = lift((value: number | undefined) => value ?? 0)(
      checksum,
    );
    const updatesView = lift((count: number | undefined) => count ?? 0)(
      updateCount,
    );
    const lastEventView = lift(sanitizeSnapshot)(lastEvent);
    const auditViewSanitized = lift(sanitizeAudit)(auditView);
    const prefixLabel = lift((text: string | undefined) =>
      typeof text === "string" && text.length > 0 ? text : "Checksum"
    )(prefix);
    const label = str`${prefixLabel} ${checksumView}`;
    const summary = str`${prefixLabel} ${checksumView} after ${updatesView}`;

    const amountField = cell<string>("1");
    const amountCandidate = derive(amountField, (text) => {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) {
        return 1;
      }
      return Math.trunc(parsed);
    });

    const recordValue = handler<
      unknown,
      {
        value: Cell<number>;
        values: Cell<number[]>;
        updateCount: Cell<number>;
        lastEvent: Cell<ChecksumSnapshot>;
        audit: Cell<ChecksumAudit>;
        amount: Cell<number>;
      }
    >(
      (
        _event,
        { value, values, updateCount, lastEvent, audit, amount },
      ) => {
        const rawAmount = amount.get();
        const amountValue = typeof rawAmount === "number" &&
            Number.isFinite(rawAmount)
          ? Math.trunc(rawAmount)
          : 1;

        const current = normalizeNumber(value.get());
        const nextValue = current + amountValue;
        value.set(nextValue);

        const existing = sanitizeNumbers(values.get());
        existing.push(nextValue);
        values.set(existing);

        const updates = updateCount.get() ?? 0;
        const updateTotal = updates + 1;
        updateCount.set(updateTotal);

        const newChecksum = computeChecksum(existing);
        const snapshot: ChecksumSnapshot = {
          amount: amountValue,
          nextValue,
          checksum: newChecksum,
        };
        const auditState: ChecksumAudit = {
          updates: updateTotal,
          checksum: newChecksum,
        };

        lastEvent.set(snapshot);
        audit.set(auditState);
      },
    )({
      value,
      values,
      updateCount,
      lastEvent,
      audit: auditView,
      amount: amountCandidate,
    });

    const currentDisplay = derive(currentValue, (val) => formatNumber(val));
    const checksumHex = derive(checksumView, (val) => formatChecksum(val));
    const checksumDec = derive(checksumView, (val) => formatNumber(val));
    const updatesDisplay = derive(updatesView, (val) => formatNumber(val));

    const valuesDisplay = lift((vals: number[]) => {
      if (vals.length === 0) {
        return "No values recorded yet";
      }
      const last5 = vals.slice(-5);
      return last5.map((v) => formatNumber(v)).join(", ");
    })(valuesView);

    const valuesCount = derive(valuesView, (vals) => vals.length);
    const valuesCountDisplay = derive(
      valuesCount,
      (count) => formatNumber(count),
    );

    const lastEventDisplay = lift((snapshot: ChecksumSnapshot) => {
      if (snapshot.amount === 0 && snapshot.nextValue === 0) {
        return "No events recorded yet";
      }
      const sign = snapshot.amount >= 0 ? "+" : "";
      return (
        "Added " + sign + formatNumber(snapshot.amount) + " → Value became " +
        formatNumber(snapshot.nextValue) + " (checksum: 0x" +
        formatChecksum(snapshot.checksum) + ")"
      );
    })(lastEventView);

    const checksumBreakdown = lift((vals: number[]) => {
      if (vals.length === 0) {
        return (
          <div style="
              text-align: center;
              padding: 2rem 1rem;
              color: #64748b;
              font-size: 0.9rem;
            ">
            Record some values to see checksum computation details
          </div>
        );
      }
      const last8 = vals.slice(-8);
      const items = last8.map((val, index) => {
        const normalized = Math.abs(val) & 0xff;
        const weight = (index % 7) + 1;
        const contribution = (normalized * weight) % 65535;
        return {
          id: "val-" + String(index),
          value: formatNumber(val),
          normalized: formatNumber(normalized),
          weight: formatNumber(weight),
          contribution: formatNumber(contribution),
        };
      });
      return items.map((item) => (
        <div
          key={item.id}
          style="
            border: 1px solid #e2e8f0;
            border-radius: 0.5rem;
            padding: 0.75rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 0.75rem;
            background: #f8fafc;
          "
        >
          <div style="
              display: flex;
              align-items: center;
              gap: 0.75rem;
              flex: 1;
            ">
            <span style="
                font-family: monospace;
                font-weight: 600;
                font-size: 1rem;
                color: #3b82f6;
                min-width: 2.5rem;
                text-align: right;
              ">
              {item.value}
            </span>
            <span style="color: #94a3b8; font-size: 0.85rem;">→</span>
            <span style="
                font-family: monospace;
                font-size: 0.85rem;
                color: #64748b;
              ">
              0x{item.normalized}
            </span>
            <span style="color: #94a3b8; font-size: 0.85rem;">×</span>
            <span style="
                font-family: monospace;
                font-size: 0.85rem;
                color: #64748b;
              ">
              {item.weight}
            </span>
            <span style="color: #94a3b8; font-size: 0.85rem;">=</span>
            <span style="
                font-family: monospace;
                font-size: 0.85rem;
                color: #059669;
                font-weight: 500;
              ">
              {item.contribution}
            </span>
          </div>
        </div>
      ));
    })(valuesView);

    const name = str`Derived checksum counter (0x${checksumHex})`;
    const status =
      str`Current value: ${currentDisplay} • Checksum: 0x${checksumHex} (${checksumDec}) • ${updatesDisplay} updates`;

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 42rem;
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
                  Checksum calculator
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Track values and compute weighted checksums
                </h2>
                <p style="
                    margin: 0;
                    font-size: 0.9rem;
                    color: #64748b;
                    line-height: 1.5;
                  ">
                  Each value is normalized to 8 bits, weighted by position
                  (1-7), and accumulated modulo 65535
                </p>
              </div>

              <div style="
                  display: grid;
                  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
                  gap: 0.75rem;
                ">
                <div style="
                    background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%);
                    border-radius: 0.75rem;
                    padding: 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <span style="font-size: 0.75rem; color: #0369a1;">
                    Current value
                  </span>
                  <strong
                    data-testid="current-value"
                    style="font-size: 1.8rem; color: #0c4a6e; font-family: monospace;"
                  >
                    {currentDisplay}
                  </strong>
                </div>
                <div style="
                    background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%);
                    border-radius: 0.75rem;
                    padding: 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <span style="font-size: 0.75rem; color: #15803d;">
                    Checksum (hex)
                  </span>
                  <strong
                    data-testid="checksum-hex"
                    style="font-size: 1.8rem; color: #14532d; font-family: monospace;"
                  >
                    0x{checksumHex}
                  </strong>
                </div>
                <div style="
                    background: linear-gradient(135deg, #faf5ff 0%, #f3e8ff 100%);
                    border-radius: 0.75rem;
                    padding: 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <span style="font-size: 0.75rem; color: #7c3aed;">
                    Checksum (dec)
                  </span>
                  <strong
                    data-testid="checksum-dec"
                    style="font-size: 1.8rem; color: #5b21b6; font-family: monospace;"
                  >
                    {checksumDec}
                  </strong>
                </div>
                <div style="
                    background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
                    border-radius: 0.75rem;
                    padding: 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <span style="font-size: 0.75rem; color: #92400e;">
                    Total values
                  </span>
                  <strong
                    data-testid="values-count"
                    style="font-size: 1.8rem; color: #78350f; font-family: monospace;"
                  >
                    {valuesCountDisplay}
                  </strong>
                </div>
              </div>

              <div style="
                  border-top: 1px solid #e2e8f0;
                  padding-top: 1rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
                <h3 style="
                    margin: 0;
                    font-size: 0.95rem;
                    font-weight: 600;
                    color: #0f172a;
                  ">
                  Record new value
                </h3>
                <div style="
                    display: flex;
                    gap: 0.75rem;
                    align-items: flex-end;
                  ">
                  <div style="
                      flex: 1;
                      display: flex;
                      flex-direction: column;
                      gap: 0.4rem;
                    ">
                    <label
                      for="amount"
                      style="
                        font-size: 0.85rem;
                        font-weight: 500;
                        color: #334155;
                      "
                    >
                      Amount to add
                    </label>
                    <ct-input
                      id="amount"
                      type="number"
                      step="1"
                      $value={amountField}
                      aria-label="Enter amount to add to counter"
                    >
                    </ct-input>
                  </div>
                  <ct-button onClick={recordValue}>
                    Record +{amountCandidate}
                  </ct-button>
                </div>
              </div>

              <div style="
                  background: #f8fafc;
                  border-radius: 0.75rem;
                  padding: 0.75rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                ">
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                  ">
                  <span style="
                      font-size: 0.8rem;
                      font-weight: 600;
                      color: #475569;
                      text-transform: uppercase;
                      letter-spacing: 0.05em;
                    ">
                    Last event
                  </span>
                  <ct-badge variant="outline">
                    {updatesDisplay} updates
                  </ct-badge>
                </div>
                <div
                  data-testid="last-event"
                  style="font-size: 0.9rem; color: #334155; line-height: 1.4;"
                >
                  {lastEventDisplay}
                </div>
              </div>

              <div style="
                  background: #f1f5f9;
                  border-radius: 0.75rem;
                  padding: 0.75rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                ">
                <span style="
                    font-size: 0.8rem;
                    font-weight: 600;
                    color: #475569;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                  ">
                  Recent values
                </span>
                <div style="
                    font-family: monospace;
                    font-size: 0.95rem;
                    color: #334155;
                  ">
                  {valuesDisplay}
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
                Checksum computation breakdown
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
              "
            >
              {checksumBreakdown}
            </div>
          </ct-card>

          <div
            role="status"
            aria-live="polite"
            data-testid="status"
            style="font-size: 0.85rem; color: #475569;"
          >
            {status}
          </div>
        </div>
      ),
      value,
      values: valuesView,
      checksum: checksumView,
      updates: updatesView,
      lastEvent: lastEventView,
      label,
      summary,
      audit: auditViewSanitized,
      recordValue,
      currentValue,
      currentDisplay,
      checksumHex,
      checksumDec,
      updatesDisplay,
      valuesDisplay,
      valuesCount,
      valuesCountDisplay,
      lastEventDisplay,
      checksumBreakdown,
      name,
      status,
      inputs: {
        amountField,
        amountCandidate,
      },
    };
  },
);

export default counterWithDerivedChecksumUx;
