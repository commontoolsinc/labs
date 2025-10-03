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

interface ParameterizedChildArgs {
  identity: Default<string, "child">;
  value: Default<number, 0>;
  step: Default<number, 1>;
  labelPrefix: Default<string, "Child">;
}

interface ChildConfig {
  id: string;
  start: number;
  step: number;
  labelPrefix: string;
}

type ChildConfigInput = Partial<ChildConfig> & { id?: string };

interface ChildSpecializationRecord {
  id: string;
  step: number;
  labelPrefix: string;
  start: number;
}

interface NestedParameterizedArgs {
  configs: Default<ChildConfigInput[], []>;
}

const toFiniteNumber = (input: unknown, fallback: number): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) return fallback;
  return input;
};

const toPositiveInteger = (input: unknown, fallback: number): number => {
  const value = Math.trunc(toFiniteNumber(input, fallback));
  return value > 0 ? value : fallback;
};

const normalizeStep = (input: unknown): number => {
  const value = toFiniteNumber(input, 1);
  if (value === 0) return 1;
  return Math.abs(value);
};

const sanitizeLabelPrefix = (input: unknown, fallback: string): string => {
  if (typeof input !== "string") return fallback;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const sanitizeIdentity = (input: unknown, index: number): string => {
  if (typeof input === "string" && input.trim().length > 0) {
    return input.trim();
  }
  return `child-${index + 1}`;
};

const sanitizeChildConfig = (
  entry: unknown,
  index: number,
): ChildConfig => {
  const value = typeof entry === "object" && entry !== null ? entry : {};
  const id = sanitizeIdentity((value as any).id, index);
  const start = Math.trunc(toFiniteNumber((value as any).start, 0));
  const step = normalizeStep((value as any).step);
  const labelPrefix = sanitizeLabelPrefix((value as any).labelPrefix, "Child");
  return { id, start, step, labelPrefix };
};

const sanitizeConfigEntries = (input: unknown): ChildConfig[] => {
  if (!Array.isArray(input)) return [];
  return input.map((entry, index) => sanitizeChildConfig(entry, index));
};

const childIncrement = handler(
  (
    event: { cycles?: number } | undefined,
    context: { value: Cell<number>; step: Cell<number> },
  ) => {
    const current = toFiniteNumber(context.value.get(), 0);
    const step = normalizeStep(context.step.get());
    const multiplier = toPositiveInteger(event?.cycles, 1);
    const next = current + step * multiplier;
    context.value.set(next);
  },
);

export const parameterizedChildCounter = recipe<ParameterizedChildArgs>(
  "Parameterized Child Counter",
  ({ identity, value, step, labelPrefix }) => {
    const safeIdentity = lift((input: string | undefined) =>
      typeof input === "string" && input.trim().length > 0
        ? input.trim()
        : "child"
    )(identity);

    const normalizedStep = lift((input: number | undefined) =>
      normalizeStep(input)
    )(step);

    const normalizedValue = lift((input: number | undefined) =>
      toFiniteNumber(input, 0)
    )(value);

    const sanitizedPrefix = lift((input: string | undefined) =>
      sanitizeLabelPrefix(input, "Child")
    )(labelPrefix);

    const label =
      str`${sanitizedPrefix} (${safeIdentity}) value ${normalizedValue}`;
    const summary = str`${safeIdentity} step ${normalizedStep}`;

    const increment = childIncrement({
      value,
      step: normalizedStep,
    });

    const cyclesField = cell<string>("1");
    const cyclesMagnitude = derive(cyclesField, (text) => {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) {
        return 1;
      }
      const normalized = Math.abs(Math.trunc(parsed));
      return normalized === 0 ? 1 : normalized;
    });

    const valueDisplay = derive(normalizedValue, (val) => `${Math.trunc(val)}`);
    const stepDisplay = derive(normalizedStep, (val) => `${Math.trunc(val)}`);

    const applyIncrement = handler<
      unknown,
      {
        value: Cell<number>;
        step: Cell<number>;
        cycles: Cell<number>;
      }
    >((_event, { value, step, cycles }) => {
      const current = toFiniteNumber(value.get(), 0);
      const stepVal = normalizeStep(step.get());
      const multiplier = toPositiveInteger(cycles.get(), 1);
      const next = current + stepVal * multiplier;
      value.set(next);
    })({ value, step: normalizedStep, cycles: cyclesMagnitude });

    return {
      identity: safeIdentity,
      value: normalizedValue,
      step: normalizedStep,
      label,
      summary,
      increment,
      [UI]: (
        <ct-card>
          <div
            slot="content"
            style="
              display: flex;
              flex-direction: column;
              gap: 0.75rem;
            "
          >
            <div style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              ">
              <div>
                <strong style="font-size: 0.95rem; color: #0f172a;">
                  {sanitizedPrefix} ({safeIdentity})
                </strong>
                <div style="font-size: 0.8rem; color: #475569; margin-top: 0.25rem;">
                  Step size: {stepDisplay}
                </div>
              </div>
              <ct-badge variant="outline">
                Value: {valueDisplay}
              </ct-badge>
            </div>

            <div style="
                display: grid;
                grid-template-columns: 1fr auto;
                gap: 0.5rem;
                align-items: end;
              ">
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.4rem;
                ">
                <label style="
                    font-size: 0.85rem;
                    font-weight: 500;
                    color: #334155;
                  ">
                  Cycles
                </label>
                <ct-input
                  type="number"
                  step="1"
                  min="1"
                  $value={cyclesField}
                  aria-label="Number of cycles to increment"
                >
                </ct-input>
              </div>
              <ct-button onClick={applyIncrement}>
                +{stepDisplay} × {cyclesMagnitude}
              </ct-button>
            </div>
          </div>
        </ct-card>
      ),
      cyclesField,
      cyclesMagnitude,
      valueDisplay,
      stepDisplay,
      controls: {
        applyIncrement,
      },
    };
  },
);

const configureChildren = handler(
  (
    event: { configs?: unknown } | undefined,
    context: {
      configs: Cell<ChildConfigInput[]>;
      version: Cell<number>;
    },
  ) => {
    if (!event || !("configs" in event)) return;
    const entries = sanitizeConfigEntries(event.configs);
    context.configs.set(entries);
    const current = toFiniteNumber(context.version.get(), 0);
    context.version.set(current + 1);
  },
);

const describeConfigs = (entries: ChildConfig[]) => {
  if (entries.length === 0) {
    return "No child counters configured";
  }
  return entries
    .map((config) => `${config.id} (step ${config.step})`)
    .join(", ");
};

export const counterNestedParameterizedUx = recipe<NestedParameterizedArgs>(
  "Counter With Nested Parameterized Patterns (UX)",
  ({ configs }) => {
    const configurationVersion = cell(0);

    const sanitizedConfigs = lift((entries: ChildConfigInput[] | undefined) =>
      sanitizeConfigEntries(entries)
    )(configs);

    const manifest = lift((entries: ChildConfig[]) => {
      const records = entries.map((config) => ({
        id: config.id,
        step: config.step,
        labelPrefix: config.labelPrefix,
        start: config.start,
      }));
      return records;
    })(sanitizedConfigs);

    const children = lift((entries: ChildConfig[]) => {
      return entries.map((config) =>
        parameterizedChildCounter({
          identity: config.id,
          value: config.start,
          step: config.step,
          labelPrefix: config.labelPrefix,
        })
      );
    })(sanitizedConfigs);

    const childCount = derive(sanitizedConfigs, (entries) => entries.length);

    const manifestLabels = derive(manifest, (records) => {
      if (records.length === 0) return "none";
      return records
        .map((record) => `${record.id}:${record.step}`)
        .join(", ");
    });

    const summary = str`Specializations ${manifestLabels}`;

    const configure = configureChildren({
      configs,
      version: configurationVersion,
    });

    const childCountDisplay = derive(childCount, (count) => `${count}`);

    const configDesc = derive(
      sanitizedConfigs,
      (entries) => describeConfigs(entries),
    );

    const showClearButton = derive(childCount, (count) => count > 0);

    const name = str`Nested parameterized counters (${childCountDisplay})`;

    const newIdField = cell<string>("");
    const newStartField = cell<string>("0");
    const newStepField = cell<string>("1");
    const newPrefixField = cell<string>("Child");

    const addChild = handler<
      unknown,
      {
        configs: Cell<ChildConfigInput[]>;
        version: Cell<number>;
        id: Cell<string>;
        start: Cell<string>;
        step: Cell<string>;
        prefix: Cell<string>;
      }
    >((_event, { configs, version, id, start, step, prefix }) => {
      const current = sanitizeConfigEntries(configs.get());
      const newId = id.get().trim() || `child-${current.length + 1}`;
      const newStart = Math.trunc(toFiniteNumber(Number(start.get()), 0));
      const newStep = normalizeStep(Number(step.get()));
      const newPrefix = sanitizeLabelPrefix(prefix.get(), "Child");

      const newConfig: ChildConfig = {
        id: newId,
        start: newStart,
        step: newStep,
        labelPrefix: newPrefix,
      };

      configs.set([...current, newConfig]);
      version.set(toFiniteNumber(version.get(), 0) + 1);

      // Clear form
      id.set("");
      start.set("0");
      step.set("1");
      prefix.set("Child");
    })({
      configs,
      version: configurationVersion,
      id: newIdField,
      start: newStartField,
      step: newStepField,
      prefix: newPrefixField,
    });

    const clearAll = handler<
      unknown,
      {
        configs: Cell<ChildConfigInput[]>;
        version: Cell<number>;
      }
    >((_event, { configs, version }) => {
      configs.set([]);
      version.set(toFiniteNumber(version.get(), 0) + 1);
    })({ configs, version: configurationVersion });

    const childCards = lift(({ items }: {
      items: typeof children extends Cell<infer T> ? T : never;
    }) => {
      if (items.length === 0) {
        return (
          <div style="
              padding: 2rem;
              text-align: center;
              color: #475569;
            ">
            No child counters yet. Add one using the form below.
          </div>
        );
      }
      return (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
          ">
          {items.map((child) => child[UI])}
        </div>
      );
    })({ items: children });

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
                  Nested parameterized pattern
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Create and manage multiple child counters
                </h2>
                <p style="
                    margin: 0;
                    font-size: 0.9rem;
                    color: #475569;
                  ">
                  Each counter can have custom ID, starting value, step size,
                  and label prefix
                </p>
              </div>

              <div style="
                  background: #f8fafc;
                  border-radius: 0.75rem;
                  padding: 0.75rem;
                ">
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                  ">
                  <div>
                    <strong style="font-size: 0.95rem; color: #0f172a;">
                      Active counters
                    </strong>
                    <div style="
                        font-size: 0.8rem;
                        color: #475569;
                        margin-top: 0.25rem;
                      ">
                      {configDesc}
                    </div>
                  </div>
                  <ct-badge>{childCountDisplay}</ct-badge>
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
                Child counters
              </h3>
              <div
                style={lift((show: boolean) =>
                  show ? "display: block;" : "display: none;"
                )(showClearButton)}
              >
                <ct-button variant="secondary" size="small" onClick={clearAll}>
                  Clear all
                </ct-button>
              </div>
            </div>
            <div slot="content">
              {childCards}
            </div>
          </ct-card>

          <ct-card>
            <div slot="header">
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Add new child counter
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.75rem;
              "
            >
              <div style="
                  display: grid;
                  grid-template-columns: repeat(2, minmax(0, 1fr));
                  gap: 0.75rem;
                ">
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    ">
                    Counter ID
                  </label>
                  <ct-input
                    type="text"
                    $value={newIdField}
                    placeholder="e.g., alpha"
                    aria-label="Unique identifier for the counter"
                  >
                  </ct-input>
                </div>

                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    ">
                    Label prefix
                  </label>
                  <ct-input
                    type="text"
                    $value={newPrefixField}
                    placeholder="Child"
                    aria-label="Label prefix for the counter"
                  >
                  </ct-input>
                </div>
              </div>

              <div style="
                  display: grid;
                  grid-template-columns: repeat(2, minmax(0, 1fr));
                  gap: 0.75rem;
                ">
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    ">
                    Starting value
                  </label>
                  <ct-input
                    type="number"
                    step="1"
                    $value={newStartField}
                    aria-label="Initial value for the counter"
                  >
                  </ct-input>
                </div>

                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    ">
                    Step size
                  </label>
                  <ct-input
                    type="number"
                    step="1"
                    min="1"
                    $value={newStepField}
                    aria-label="Amount to increment by"
                  >
                  </ct-input>
                </div>
              </div>

              <ct-button onClick={addChild}>
                Add child counter
              </ct-button>
            </div>
          </ct-card>

          <div
            role="status"
            aria-live="polite"
            data-testid="status"
            style="font-size: 0.85rem; color: #475569;"
          >
            {summary}
          </div>
        </div>
      ),
      configs,
      children,
      childCount,
      manifest,
      summary,
      configure,
      reconfigurations: configurationVersion,
      name,
      configDesc,
      childCountDisplay,
      fields: {
        newIdField,
        newStartField,
        newStepField,
        newPrefixField,
      },
      controls: {
        addChild,
        clearAll,
      },
    };
  },
);

export default counterNestedParameterizedUx;
