import { CellImpl, getRecipe, getRecipeId } from "@commontools/common-runner";
import { Recipe, Module, TYPE } from "@commontools/common-builder";

export function getRuleName(inputBindings: any, outputBindings: any) {
  const alias = inputBindings?.$event?.$alias ?? outputBindings?.$alias;
  if (alias) return alias.path.slice(1).join("/");

  if (outputBindings)
    if (typeof outputBindings === "object" && outputBindings !== null)
      return Object.keys(outputBindings).join("-");
    else return outputBindings.toString();

  if (inputBindings)
    if (typeof inputBindings === "object" && inputBindings !== null)
      return Object.keys(inputBindings).join("-");
    else return inputBindings.toString();

  return "unknown";
}

export function recipeToBehavior(recipeId: string) {
  const recipe = getRecipe(recipeId) as Recipe;
  if (!recipe) return null;

  const rules: Record<string, any> = {};

  recipe.nodes.forEach(node => {
    if ((node.module as Module).type !== "javascript") return;
    const name = getRuleName(node.inputs, node.outputs);
    rules[name] = { select: Object.entries(node.inputs ?? {}), where: [] };
  });

  return {
    id: recipeId,
    rules,
    isRuleEnabled: (_rule: string) => true,
  };
}

export function notifyQueryTriggered(
  processCell: CellImpl<any>,
  recipe: Recipe,
  ruleId: string,
) {
  window.dispatchEvent(
    new CustomEvent("query-triggered", {
      detail: {
        entity: processCell.entityId,
        spell: getRecipeId(recipe),
        rule: ruleId,
      },
    }),
  );
}

export function notifyMutation(
  processCell: CellImpl<any>,
  path: PropertyKey[],
  newValue: any,
) {
  const value = processCell.getAsQueryResult([]);

  window.dispatchEvent(
    new CustomEvent("mutation", {
      detail: {
        entity: JSON.stringify(processCell.entityId),
        spell:
          typeof value === "object" && value !== null
            ? (value as any)?.[TYPE]
            : undefined, // TODO: Find sourceCell
        changes: [
          {
            Upsert: [
              processCell.entityId,
              path.join("/"),
              JSON.stringify(newValue),
            ],
          },
        ],
      },
    }),
  );
}
