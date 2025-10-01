/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

const defaultDays = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
];

type MealSlot = "breakfast" | "lunch" | "dinner";

interface Ingredient {
  name: string;
  quantity: number;
  unit: string;
}

interface RecipeDefinition {
  name: string;
  ingredients: Ingredient[];
}

interface PlannedMeal {
  day: string;
  meal: MealSlot;
  recipe: string;
}

const defaultRecipes: RecipeDefinition[] = [
  {
    name: "Oatmeal Bowl",
    ingredients: [
      { name: "Rolled Oats", quantity: 1, unit: "cup" },
      { name: "Milk", quantity: 1, unit: "cup" },
      { name: "Berries", quantity: 0.5, unit: "cup" },
    ],
  },
  {
    name: "Veggie Curry",
    ingredients: [
      { name: "Chickpeas", quantity: 1, unit: "can" },
      { name: "Spinach", quantity: 2, unit: "cup" },
      { name: "Curry Paste", quantity: 2, unit: "tbsp" },
    ],
  },
  {
    name: "Quinoa Salad",
    ingredients: [
      { name: "Quinoa", quantity: 1, unit: "cup" },
      { name: "Cherry Tomato", quantity: 1, unit: "cup" },
      { name: "Olive Oil", quantity: 2, unit: "tbsp" },
    ],
  },
];

interface MenuPlannerArgs {
  days: Default<string[], typeof defaultDays>;
  recipes: Default<RecipeDefinition[], typeof defaultRecipes>;
  plan: Default<PlannedMeal[], []>;
}

interface AssignmentEvent {
  day?: string;
  meal?: string;
  recipe?: string;
}

interface ShoppingEntry {
  name: string;
  unit: string;
  quantity: number;
}

const mealSlots: MealSlot[] = ["breakfast", "lunch", "dinner"];

const sanitizeText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const sanitizeDays = (value: readonly string[] | undefined): string[] => {
  if (!Array.isArray(value)) return [...defaultDays];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const sanitized = sanitizeText(entry);
    if (!sanitized) continue;
    const normalized = sanitized[0].toUpperCase() + sanitized.slice(1);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result.length > 0 ? result : [...defaultDays];
};

const sanitizeIngredient = (
  value: Ingredient | undefined,
): Ingredient | null => {
  const name = sanitizeText(value?.name);
  if (!name) return null;
  const unit = sanitizeText(value?.unit) ?? "unit";
  const quantity = typeof value?.quantity === "number" &&
      Number.isFinite(value.quantity)
    ? Math.max(Math.round(value.quantity * 100) / 100, 0)
    : 0;
  return { name, unit, quantity };
};

const sanitizeRecipes = (
  value: readonly RecipeDefinition[] | undefined,
): RecipeDefinition[] => {
  if (!Array.isArray(value) || value.length === 0) {
    return structuredClone(defaultRecipes);
  }
  const recipes: RecipeDefinition[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const name = sanitizeText(entry?.name);
    if (!name || seen.has(name)) continue;
    const ingredients: Ingredient[] = [];
    if (Array.isArray(entry?.ingredients)) {
      for (const item of entry.ingredients) {
        const sanitized = sanitizeIngredient(item);
        if (sanitized && sanitized.quantity > 0) {
          ingredients.push(sanitized);
        }
      }
    }
    if (ingredients.length > 0) {
      seen.add(name);
      recipes.push({ name, ingredients });
    }
  }
  return recipes.length > 0 ? recipes : structuredClone(defaultRecipes);
};

const sanitizeMealSlot = (value: unknown): MealSlot => {
  const normalized = sanitizeText(value)?.toLowerCase();
  if (normalized === "lunch" || normalized === "dinner") {
    return normalized;
  }
  return "breakfast";
};

const sanitizePlan = (
  value: readonly PlannedMeal[] | undefined,
  days: readonly string[],
  recipes: readonly RecipeDefinition[],
): PlannedMeal[] => {
  if (!Array.isArray(value)) return [];
  const validDays = new Set(days);
  const validRecipes = new Set(recipes.map((entry) => entry.name));
  const result: PlannedMeal[] = [];
  for (const entry of value) {
    const day = sanitizeText(entry?.day);
    if (!day || !validDays.has(day)) continue;
    const meal = sanitizeMealSlot(entry?.meal);
    const recipe = sanitizeText(entry?.recipe);
    if (!recipe || !validRecipes.has(recipe)) continue;
    result.push({ day, meal, recipe });
  }
  return result;
};

const buildRecipeMap = (recipes: readonly RecipeDefinition[]) => {
  const map = new Map<string, Ingredient[]>();
  for (const entry of recipes) {
    map.set(entry.name, entry.ingredients);
  }
  return map;
};

const aggregateShopping = (
  plan: readonly PlannedMeal[],
  recipes: readonly RecipeDefinition[],
): ShoppingEntry[] => {
  const recipeMap = buildRecipeMap(recipes);
  const totals = new Map<string, ShoppingEntry>();
  for (const item of plan) {
    const ingredients = recipeMap.get(item.recipe);
    if (!ingredients) continue;
    for (const ingredient of ingredients) {
      const key = `${ingredient.name}__${ingredient.unit}`;
      const previous = totals.get(key);
      const quantity = (previous?.quantity ?? 0) + ingredient.quantity;
      totals.set(key, {
        name: ingredient.name,
        unit: ingredient.unit,
        quantity: Math.round(quantity * 100) / 100,
      });
    }
  }
  const entries = Array.from(totals.values());
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return entries;
};

const ensurePlanStructure = (
  days: readonly string[],
  plan: readonly PlannedMeal[],
): Record<string, Record<MealSlot, string>> => {
  const structure: Record<string, Record<MealSlot, string>> = {};
  for (const day of days) {
    structure[day] = { breakfast: "", lunch: "", dinner: "" };
  }
  for (const entry of plan) {
    if (!structure[entry.day]) continue;
    structure[entry.day][entry.meal] = entry.recipe;
  }
  return structure;
};

export const menuPlannerUx = recipe<MenuPlannerArgs>(
  "Menu Planner (UX)",
  ({ days, recipes, plan }) => {
    const daysView = lift(sanitizeDays)(days);
    const recipesView = lift(sanitizeRecipes)(recipes);
    const planView = lift((inputs: {
      plan: PlannedMeal[] | undefined;
      days: string[];
      recipes: RecipeDefinition[];
    }) => sanitizePlan(inputs.plan, inputs.days, inputs.recipes))({
      plan,
      days: daysView,
      recipes: recipesView,
    });

    const planByDay = lift((inputs: {
      days: string[];
      plan: PlannedMeal[];
    }) => ensurePlanStructure(inputs.days, inputs.plan))({
      days: daysView,
      plan: planView,
    });

    const shoppingList = lift((inputs: {
      plan: PlannedMeal[];
      recipes: RecipeDefinition[];
    }) => aggregateShopping(inputs.plan, inputs.recipes))({
      plan: planView,
      recipes: recipesView,
    });

    const plannedCount = lift((entries: PlannedMeal[] | undefined) =>
      Array.isArray(entries) ? entries.length : 0
    )(planView);

    const name = str`Menu Planner - ${plannedCount} meals`;

    // Form fields
    const dayField = cell<string>("");
    const mealField = cell<string>("");
    const recipeField = cell<string>("");

    // UI-specific assign handler
    const assignMealUi = handler(
      (
        _event: unknown,
        context: {
          dayField: Cell<string>;
          mealField: Cell<string>;
          recipeField: Cell<string>;
          plan: Cell<PlannedMeal[]>;
          daysView: Cell<string[]>;
          recipesView: Cell<RecipeDefinition[]>;
        },
      ) => {
        const dayInput = context.dayField.get();
        const mealInput = context.mealField.get();
        const recipeInput = context.recipeField.get();

        const dayList = context.daysView.get();
        const recipeList = context.recipesView.get();
        const validDays = new Set(dayList);
        const validRecipes = new Set(recipeList.map((entry) => entry.name));

        const day = sanitizeText(dayInput) ?? dayList[0];
        if (!validDays.has(day)) return;
        const meal = sanitizeMealSlot(mealInput);
        const recipe = sanitizeText(recipeInput);
        if (!recipe || !validRecipes.has(recipe)) return;

        const current = sanitizePlan(
          context.plan.get(),
          dayList,
          recipeList,
        );
        const filtered = current.filter((entry) =>
          !(entry.day === day && entry.meal === meal)
        );
        filtered.push({ day, meal, recipe });
        context.plan.set(filtered);

        // Clear form
        context.dayField.set("");
        context.mealField.set("");
        context.recipeField.set("");
      },
    )({ dayField, mealField, recipeField, plan, daysView, recipesView });

    // UI-specific clear handler
    const clearMealUi = handler(
      (
        _event: unknown,
        context: {
          dayField: Cell<string>;
          mealField: Cell<string>;
          plan: Cell<PlannedMeal[]>;
          daysView: Cell<string[]>;
          recipesView: Cell<RecipeDefinition[]>;
        },
      ) => {
        const dayInput = context.dayField.get();
        const mealInput = context.mealField.get();

        const dayList = context.daysView.get();
        const recipeList = context.recipesView.get();

        const day = sanitizeText(dayInput) ?? dayList[0];
        if (!dayList.includes(day)) return;
        const meal = sanitizeMealSlot(mealInput);

        const current = sanitizePlan(
          context.plan.get(),
          dayList,
          recipeList,
        );
        const filtered = current.filter((entry) =>
          !(entry.day === day && entry.meal === meal)
        );
        context.plan.set(filtered);

        // Clear form
        context.dayField.set("");
        context.mealField.set("");
      },
    )({ dayField, mealField, plan, daysView, recipesView });

    // Build weekly grid UI
    const weeklyGrid = lift((p: Record<string, Record<MealSlot, string>>) => {
      const days = Object.keys(p);
      const mealColors: Record<MealSlot, string> = {
        breakfast: "#fef3c7",
        lunch: "#dbeafe",
        dinner: "#fce7f3",
      };
      const dayElements = [];
      for (const day of days) {
        const dayMeals = p[day];
        const mealElements = [];
        for (const meal of mealSlots) {
          const recipeName = dayMeals[meal] || "";
          const bgColor = mealColors[meal];
          const borderColor = recipeName ? "#3b82f6" : "#d1d5db";
          const style = "padding: 12px; background: " + bgColor +
            "; border: 2px solid " + borderColor +
            "; border-radius: 8px; min-height: 80px;";
          mealElements.push(
            h("div", { style }, [
              h(
                "div",
                {
                  style:
                    "font-size: 0.75rem; font-weight: 600; text-transform: uppercase; color: #6b7280; margin-bottom: 4px;",
                },
                meal,
              ),
              h(
                "div",
                { style: "font-size: 0.875rem; font-weight: 500;" },
                recipeName || "—",
              ),
            ]),
          );
        }
        dayElements.push(
          h("div", {}, [
            h(
              "div",
              {
                style:
                  "font-weight: 700; font-size: 1rem; margin-bottom: 8px; color: #1f2937; border-bottom: 2px solid #3b82f6; padding-bottom: 4px;",
              },
              day,
            ),
            h(
              "div",
              { style: "display: flex; flex-direction: column; gap: 8px;" },
              ...mealElements,
            ),
          ]),
        );
      }
      return h(
        "div",
        {
          style:
            "display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px;",
        },
        ...dayElements,
      );
    })(planByDay);

    // Build shopping list UI
    const shoppingListUi = lift((items: ShoppingEntry[]) => {
      if (items.length === 0) {
        return h(
          "div",
          {
            style:
              "padding: 24px; text-align: center; color: #6b7280; border: 2px dashed #d1d5db; border-radius: 8px;",
          },
          "No items on shopping list yet. Add meals to your plan!",
        );
      }
      const elements = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const bgColor = i % 2 === 0 ? "#ffffff" : "#f9fafb";
        const style =
          "display: flex; justify-content: space-between; padding: 12px; background: " +
          bgColor + "; border-bottom: 1px solid #e5e7eb;";
        elements.push(
          h("div", { style }, [
            h("span", { style: "font-weight: 500;" }, item.name),
            h(
              "span",
              { style: "color: #6b7280; font-family: monospace;" },
              String(item.quantity) + " " + item.unit,
            ),
          ]),
        );
      }
      return h(
        "div",
        {
          style:
            "border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;",
        },
        ...elements,
      );
    })(shoppingList);

    // Build recipes reference UI
    const recipesReferenceUi = lift((recs: RecipeDefinition[]) => {
      const elements = [];
      for (const rec of recs) {
        const ingredientElements = [];
        for (const ing of rec.ingredients) {
          ingredientElements.push(
            h(
              "li",
              { style: "color: #6b7280; font-size: 0.875rem;" },
              ing.name + " - " + String(ing.quantity) + " " + ing.unit,
            ),
          );
        }
        elements.push(
          h(
            "div",
            {
              style:
                "padding: 12px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px;",
            },
            [
              h(
                "div",
                {
                  style:
                    "font-weight: 600; margin-bottom: 8px; color: #1f2937;",
                },
                rec.name,
              ),
              h(
                "ul",
                { style: "margin: 0; padding-left: 20px;" },
                ...ingredientElements,
              ),
            ],
          ),
        );
      }
      return h("div", {
        style: "display: flex; flex-direction: column; gap: 8px;",
      }, ...elements);
    })(recipesView);

    const ui = (
      <div
        style={{
          fontFamily: "system-ui, -apple-system, sans-serif",
          maxWidth: "1200px",
          margin: "0 auto",
          padding: "24px",
          background: "linear-gradient(135deg, #fef3c7 0%, #fce7f3 100%)",
          minHeight: "100vh",
        }}
      >
        <div
          style={{
            background: "white",
            borderRadius: "16px",
            padding: "24px",
            boxShadow: "0 4px 6px rgba(0,0,0,0.1)",
          }}
        >
          <h1
            style={{
              fontSize: "2rem",
              fontWeight: "800",
              marginBottom: "8px",
              color: "#1f2937",
              borderBottom: "3px solid #3b82f6",
              paddingBottom: "8px",
            }}
          >
            🍽️ Weekly Menu Planner
          </h1>
          <p
            style={{
              color: "#6b7280",
              fontSize: "1rem",
              marginBottom: "24px",
            }}
          >
            {plannedCount} meals scheduled
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "24px",
            }}
          >
            <div>
              <h2
                style={{
                  fontSize: "1.25rem",
                  fontWeight: "700",
                  marginBottom: "16px",
                  color: "#1f2937",
                }}
              >
                📅 Weekly Plan
              </h2>
              {weeklyGrid}
            </div>

            <div
              style={{ display: "flex", flexDirection: "column", gap: "24px" }}
            >
              <div>
                <h2
                  style={{
                    fontSize: "1.25rem",
                    fontWeight: "700",
                    marginBottom: "16px",
                    color: "#1f2937",
                  }}
                >
                  🛒 Shopping List
                </h2>
                {shoppingListUi}
              </div>

              <div>
                <h2
                  style={{
                    fontSize: "1.25rem",
                    fontWeight: "700",
                    marginBottom: "16px",
                    color: "#1f2937",
                  }}
                >
                  👨‍🍳 Available Recipes
                </h2>
                {recipesReferenceUi}
              </div>
            </div>
          </div>

          <div
            style={{
              marginTop: "32px",
              padding: "24px",
              background: "linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%)",
              borderRadius: "12px",
            }}
          >
            <h2
              style={{
                fontSize: "1.25rem",
                fontWeight: "700",
                marginBottom: "16px",
                color: "#1f2937",
              }}
            >
              ✏️ Assign Meal
            </h2>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 2fr",
                gap: "12px",
              }}
            >
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: "0.875rem",
                    fontWeight: "600",
                    marginBottom: "4px",
                    color: "#374151",
                  }}
                >
                  Day
                </label>
                <ct-input
                  $value={dayField}
                  placeholder="Monday"
                  style={{
                    width: "100%",
                    padding: "8px",
                    borderRadius: "6px",
                    border: "1px solid #d1d5db",
                  }}
                />
              </div>
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: "0.875rem",
                    fontWeight: "600",
                    marginBottom: "4px",
                    color: "#374151",
                  }}
                >
                  Meal
                </label>
                <ct-input
                  $value={mealField}
                  placeholder="breakfast"
                  style={{
                    width: "100%",
                    padding: "8px",
                    borderRadius: "6px",
                    border: "1px solid #d1d5db",
                  }}
                />
              </div>
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: "0.875rem",
                    fontWeight: "600",
                    marginBottom: "4px",
                    color: "#374151",
                  }}
                >
                  Recipe
                </label>
                <ct-input
                  $value={recipeField}
                  placeholder="Oatmeal Bowl"
                  style={{
                    width: "100%",
                    padding: "8px",
                    borderRadius: "6px",
                    border: "1px solid #d1d5db",
                  }}
                />
              </div>
            </div>
            <div style={{ display: "flex", gap: "12px", marginTop: "16px" }}>
              <ct-button
                onClick={assignMealUi}
                style={{
                  background: "#3b82f6",
                  color: "white",
                  padding: "10px 20px",
                  borderRadius: "8px",
                  fontWeight: "600",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                Assign Meal
              </ct-button>
              <ct-button
                onClick={clearMealUi}
                style={{
                  background: "#ef4444",
                  color: "white",
                  padding: "10px 20px",
                  borderRadius: "8px",
                  fontWeight: "600",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                Clear Meal Slot
              </ct-button>
            </div>
          </div>
        </div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      days,
      recipes,
      plan,
      planByDay,
      shoppingList,
      plannedCount,
    };
  },
);
