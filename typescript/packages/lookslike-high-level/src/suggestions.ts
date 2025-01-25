import { Recipe } from "@commontools/builder";

export type Suggestion = {
  // Description of the suggestion
  description: string[];

  // Recipe to run when the suggestion is clicked
  recipe: Recipe;

  // Map from locally available data to recipe input:
  bindings: { [key: string]: string };

  // Map from recipe input to globally available charm type:
  charms: { [key: string]: string };
};

export const suggestions: Suggestion[] = [];

export function addSuggestion(suggestion: Suggestion) {
  suggestions.push(suggestion);
}

export function description(strings: TemplateStringsArray, ...values: any[]) {
  return strings.map((string, i) => [string, values[i]]).flat();
}
