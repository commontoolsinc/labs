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

interface IngredientInput {
  name?: unknown;
  quantity?: unknown;
  unit?: unknown;
}

interface Ingredient {
  name: string;
  quantity: number;
  unit: string;
}

interface ServingsEvent {
  servings?: number;
  delta?: number;
}

const defaultRecipeName = "Herb Pasta";
const defaultBaseServings = 4;
const defaultDesiredServings = 4;
const defaultIngredients: Ingredient[] = [
  { name: "Spaghetti", quantity: 200, unit: "gram" },
  { name: "Cherry Tomato", quantity: 150, unit: "gram" },
  { name: "Olive Oil", quantity: 2, unit: "tbsp" },
  { name: "Basil", quantity: 6, unit: "leaf" },
];

interface RecipeIngredientScalerArgs {
  name: Default<string, typeof defaultRecipeName>;
  baseServings: Default<number, typeof defaultBaseServings>;
  desiredServings: Default<number, typeof defaultDesiredServings>;
  ingredients: Default<Ingredient[], typeof defaultIngredients>;
}

const formatNumber = (value: number): string => {
  const fixed = value.toFixed(2);
  return fixed.replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
};

const sanitizeServings = (
  value: unknown,
  fallback: number,
  minimum = 0.5,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return Math.max(fallback, minimum);
  }
  const rounded = Math.round(value * 10) / 10;
  if (rounded < minimum) {
    return Math.max(fallback, minimum);
  }
  return rounded;
};

const sanitizeQuantity = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  return Math.round(value * 100) / 100;
};

const textOrNull = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const sanitizeIngredientList = (value: unknown): Ingredient[] => {
  if (!Array.isArray(value)) {
    return defaultIngredients.map((item) => ({ ...item }));
  }
  const result: Ingredient[] = [];
  for (const entry of value as IngredientInput[]) {
    const name = textOrNull(entry?.name);
    if (!name) continue;
    const unit = textOrNull(entry?.unit) ?? "unit";
    const quantity = sanitizeQuantity(entry?.quantity);
    if (quantity <= 0) continue;
    result.push({ name, unit, quantity });
  }
  return result.length > 0
    ? result
    : defaultIngredients.map((item) => ({ ...item }));
};

const toMultiplier = (desired: number, base: number): number => {
  if (base <= 0) return 1;
  return Math.round((desired / base) * 100) / 100;
};

const appendHistory = (history: Cell<string[]>, entry: string) => {
  const current = history.get();
  const list = Array.isArray(current) ? current : [];
  history.set([...list, entry]);
};

export const recipeIngredientScalerUx = recipe<RecipeIngredientScalerArgs>(
  "Recipe Ingredient Scaler",
  ({ name, baseServings, desiredServings, ingredients }) => {
    const history = cell<string[]>([]);

    const recipeName = lift((value: string | undefined) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0
        ? normalized
        : defaultRecipeName;
    })(name);

    const baseView = lift((value: number | undefined) =>
      sanitizeServings(value, defaultBaseServings, 1)
    )(baseServings);

    const desiredView = lift((input: {
      desired: number | undefined;
      base: number;
    }) => sanitizeServings(input.desired, input.base, 0.5))({
      desired: desiredServings,
      base: baseView,
    });

    const ingredientsView = lift(sanitizeIngredientList)(ingredients);

    const multiplier = lift((input: { desired: number; base: number }) =>
      toMultiplier(input.desired, input.base)
    )({
      desired: desiredView,
      base: baseView,
    });

    const scaledIngredients = lift((input: {
      items: Ingredient[];
      multiplier: number;
    }) =>
      input.items.map((item) => ({
        name: item.name,
        unit: item.unit,
        quantity: Math.round(item.quantity * input.multiplier * 100) / 100,
      }))
    )({
      items: ingredientsView,
      multiplier,
    });

    const desiredLabel = lift(formatNumber)(desiredView);
    const multiplierLabel = lift((value: number) => `x${formatNumber(value)}`)(
      multiplier,
    );

    const scaledLabel = lift((items: Ingredient[]) =>
      items.map((item) =>
        `${item.name}: ${formatNumber(item.quantity)} ${item.unit}`
      ).join("; ")
    )(scaledIngredients);

    const summary = lift((input: {
      name: string;
      servings: string;
      multiplier: string;
    }) => `${input.name}: ${input.servings} servings (${input.multiplier})`)({
      name: recipeName,
      servings: desiredLabel,
      multiplier: multiplierLabel,
    });

    // UI handlers
    const servingsInputCell = cell<string>("");

    const setServingsHandler = handler<
      unknown,
      {
        desiredServings: Cell<number>;
        baseServings: Cell<number>;
        history: Cell<string[]>;
        input: Cell<string>;
      }
    >((_event, { desiredServings, baseServings, history, input }) => {
      const inputValue = input.get();
      const servingsValue = parseFloat(inputValue);
      const base = sanitizeServings(
        baseServings.get(),
        defaultBaseServings,
        1,
      );
      const next = sanitizeServings(servingsValue, base, 0.5);
      desiredServings.set(next);
      const multiplierValue = toMultiplier(next, base);
      const message = `Set servings to ${formatNumber(next)} (x${
        formatNumber(multiplierValue)
      })`;
      appendHistory(history, message);
      input.set("");
    })({
      desiredServings,
      baseServings,
      history,
      input: servingsInputCell,
    });

    // Create separate handlers for each delta button
    const createAdjustHandler = (delta: number) =>
      handler<
        unknown,
        {
          desiredServings: Cell<number>;
          baseServings: Cell<number>;
          history: Cell<string[]>;
        }
      >((_event, { desiredServings, baseServings, history }) => {
        const base = sanitizeServings(
          baseServings.get(),
          defaultBaseServings,
          1,
        );
        const current = sanitizeServings(
          desiredServings.get(),
          base,
          0.5,
        );
        const next = sanitizeServings(current + delta, base, 0.5);
        desiredServings.set(next);
        const multiplierValue = toMultiplier(next, base);
        const message =
          `Adjusted by ${formatNumber(delta)} → ${formatNumber(next)} ` +
          `(x${formatNumber(multiplierValue)})`;
        appendHistory(history, message);
      })({
        desiredServings,
        baseServings,
        history,
      });

    const adjustMinus1 = createAdjustHandler(-1);
    const adjustMinus05 = createAdjustHandler(-0.5);
    const adjustPlus05 = createAdjustHandler(0.5);
    const adjustPlus1 = createAdjustHandler(1);
    const adjustPlus2 = createAdjustHandler(2);

    const name_output = str`${recipeName} (${desiredLabel} servings)`;

    return {
      [NAME]: name_output,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 56rem;
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
                  Recipe Ingredient Scaler
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.5rem;
                    color: #0f172a;
                    font-weight: 600;
                  ">
                  {recipeName}
                </h2>
              </div>

              <div style="
                  background: #f0f9ff;
                  border: 2px solid #3b82f6;
                  border-radius: 0.75rem;
                  padding: 1.25rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                  ">
                  <span style="font-size: 0.9rem; color: #475569;">
                    Servings
                  </span>
                  <div style="
                      display: flex;
                      align-items: baseline;
                      gap: 0.75rem;
                    ">
                    <strong style="
                        font-size: 2rem;
                        color: #0f172a;
                        font-weight: 700;
                      ">
                      {desiredLabel}
                    </strong>
                    <span style="
                        font-size: 1.1rem;
                        color: #3b82f6;
                        font-weight: 600;
                      ">
                      {multiplierLabel}
                    </span>
                  </div>
                </div>
                <div style="
                    font-size: 0.75rem;
                    color: #64748b;
                  ">
                  Base recipe: {lift(formatNumber)(baseView)} servings
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
                Adjust servings
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <div style="
                  display: flex;
                  gap: 0.5rem;
                  flex-wrap: wrap;
                ">
                <ct-button onClick={adjustMinus1}>
                  -1
                </ct-button>
                <ct-button onClick={adjustMinus05}>
                  -0.5
                </ct-button>
                <ct-button onClick={adjustPlus05}>
                  +0.5
                </ct-button>
                <ct-button onClick={adjustPlus1}>
                  +1
                </ct-button>
                <ct-button onClick={adjustPlus2}>
                  +2
                </ct-button>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.4rem;
                ">
                <label
                  for="servings-input"
                  style="
                    font-size: 0.85rem;
                    font-weight: 500;
                    color: #334155;
                  "
                >
                  Or enter specific servings
                </label>
                <div style="display: flex; gap: 0.5rem;">
                  <ct-input
                    id="servings-input"
                    $value={servingsInputCell}
                    placeholder="e.g., 6"
                    aria-label="Enter desired servings"
                  >
                  </ct-input>
                  <ct-button onClick={setServingsHandler}>
                    Set
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
                Scaled ingredients
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
              {lift((items: Ingredient[]) => {
                const elements = [];
                for (const item of items) {
                  const formattedQty = formatNumber(item.quantity);
                  elements.push(
                    <div style="
                        background: #f8fafc;
                        border: 1px solid #e2e8f0;
                        border-radius: 0.5rem;
                        padding: 0.75rem;
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                      ">
                      <span style="
                          font-weight: 500;
                          color: #0f172a;
                          font-size: 0.95rem;
                        ">
                        {item.name}
                      </span>
                      <span style="
                          font-family: monospace;
                          color: #3b82f6;
                          font-weight: 600;
                          font-size: 0.95rem;
                        ">
                        {formattedQty} {item.unit}
                      </span>
                    </div>,
                  );
                }
                return elements;
              })(scaledIngredients)}
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
                Adjustment history
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
                max-height: 300px;
                overflow-y: auto;
              "
            >
              {lift((entries: string[]) => {
                if (entries.length === 0) {
                  return (
                    <p style="
                        margin: 0;
                        font-size: 0.85rem;
                        color: #94a3b8;
                        font-style: italic;
                      ">
                      No adjustments yet
                    </p>
                  );
                }
                return entries.slice().reverse().map((entry, idx) => (
                  <div
                    key={idx}
                    style="
                      background: #f8fafc;
                      border-left: 3px solid #10b981;
                      border-radius: 0.25rem;
                      padding: 0.75rem;
                      font-size: 0.85rem;
                      color: #0f172a;
                    "
                  >
                    {entry}
                  </div>
                ));
              })(history)}
            </div>
          </ct-card>
        </div>
      ),
      recipeName,
      baseServings: baseView,
      desiredServings: desiredView,
      desiredLabel,
      multiplier,
      multiplierLabel,
      ingredients: ingredientsView,
      scaledIngredients,
      scaledLabel,
      summary,
      history,
    };
  },
);

export default recipeIngredientScalerUx;
