/// <cts-enable />
import {
  type Cell,
  cell,
  createCell,
  Default,
  handler,
  lift,
  recipe,
  str,
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

const assignmentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sequence", "day", "meal", "recipe"],
  properties: {
    sequence: { type: "number" },
    day: { type: "string" },
    meal: { type: "string" },
    recipe: { type: "string" },
  },
} as const;

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

export const menuPlanner = recipe<MenuPlannerArgs>(
  "Menu Planner",
  ({ days, recipes, plan }) => {
    const sequence = cell(0);
    const lastAction = cell("initialized");

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

    const status = str`${plannedCount} meals scheduled`;

    const convertContext = {
      plan,
      daysView,
      recipesView,
      planView,
      sequence,
      lastAction,
    } as const;

    const assignMeal = handler(
      (
        event: AssignmentEvent | undefined,
        context: {
          plan: Cell<PlannedMeal[]>;
          daysView: Cell<string[]>;
          recipesView: Cell<RecipeDefinition[]>;
          planView: Cell<PlannedMeal[]>;
          sequence: Cell<number>;
          lastAction: Cell<string>;
        },
      ) => {
        const dayList = context.daysView.get();
        const recipeList = context.recipesView.get();
        const validDays = new Set(dayList);
        const validRecipes = new Set(recipeList.map((entry) => entry.name));
        const day = sanitizeText(event?.day) ?? dayList[0];
        if (!validDays.has(day)) return;
        const meal = sanitizeMealSlot(event?.meal);
        const recipe = sanitizeText(event?.recipe);
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

        const sequenceValue = (context.sequence.get() ?? 0) + 1;
        context.sequence.set(sequenceValue);
        const action = `Assigned ${recipe} to ${day} ${meal}`;
        context.lastAction.set(action);
        createCell(
          assignmentSchema,
          `menuPlannerAssignment_${sequenceValue}`,
          { sequence: sequenceValue, day, meal, recipe },
        );
      },
    );

    const clearMeal = handler(
      (
        event: AssignmentEvent | undefined,
        context: {
          plan: Cell<PlannedMeal[]>;
          daysView: Cell<string[]>;
          recipesView: Cell<RecipeDefinition[]>;
          planView: Cell<PlannedMeal[]>;
          sequence: Cell<number>;
          lastAction: Cell<string>;
        },
      ) => {
        const dayList = context.daysView.get();
        const recipeList = context.recipesView.get();
        const day = sanitizeText(event?.day) ?? dayList[0];
        if (!dayList.includes(day)) return;
        const meal = sanitizeMealSlot(event?.meal);
        const current = sanitizePlan(
          context.plan.get(),
          dayList,
          recipeList,
        );
        const filtered = current.filter((entry) =>
          !(entry.day === day && entry.meal === meal)
        );
        context.plan.set(filtered);
        const sequenceValue = (context.sequence.get() ?? 0) + 1;
        context.sequence.set(sequenceValue);
        const action = `Cleared ${day} ${meal}`;
        context.lastAction.set(action);
        createCell(
          assignmentSchema,
          `menuPlannerAssignment_${sequenceValue}`,
          { sequence: sequenceValue, day, meal, recipe: "" },
        );
      },
    );

    return {
      days,
      recipes,
      plan,
      planByDay,
      shoppingList,
      plannedCount,
      status,
      lastAction,
      assignMeal: assignMeal(convertContext as never),
      clearMeal: clearMeal(convertContext as never),
    };
  },
);
