/** A #recipe with ingredients. */
type RecipeBase = {
  ingredients: string[];
};

/** Schedulable on the #meal-plan. */
type Schedulable = {
  plannedFor: string;
};

type SchemaRoot = RecipeBase & Schedulable;
