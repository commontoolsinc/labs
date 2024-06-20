import { signal, stream } from "@commontools/common-frp";
import { isSignal } from "@commontools/common-frp/signal";

// Should be Symbol("ID") or so, but this makes repeat() use these when
// iterating over recipes.
export const ID = "id";
export const TYPE = Symbol("type");
export const NAME = Symbol("name");

export type RecipeInputs = {
  [key: string]: any;
};

// TODO: `any` is here to support returning constant vdoms. Let's capture that
// as proper constant values in the future & disallow this on the inputs.
export type Bindings = {
  [key: string]: signal.Signal<any> | stream.Stream<any> | any;
};

export type Gem = {
  [ID]: number;
  [TYPE]: string;
  [NAME]?: string;
} & Bindings;

export function isGem(value: any): value is Gem {
  return typeof value === "object" && ID in value && TYPE in value;
}

// Readwrite signals are inputs that are passed through to the output
export type Recipe = (inputs: RecipeInputs) => Gem;

// TODO: Should be uuid.
let id = 0;

export const recipe = (
  name: string,
  impl: (inputs: Bindings) => Bindings
): Recipe => {
  return (inputs: Bindings) => {
    const inputsAsSignals = Object.fromEntries(
      Object.entries(inputs).map(([key, value]) => [
        key,
        isSignal(value) ? value : signal.state(value),
      ])
    );
    const outputs = impl(inputsAsSignals);
    return { [ID]: id++, [TYPE]: name, ...outputs };
  };
};

export type Suggestion = {
  // Description of the suggestion
  description: string[];

  // Recipe to run when the suggestion is clicked
  recipe: Recipe;

  // Map from locally available data to recipe input:
  bindings: { [key: string]: string };

  // Map from recipe input to globally available data gem type:
  dataGems: { [key: string]: string };
};

export const suggestions = signal.state<Suggestion[]>([]);

export function description(strings: TemplateStringsArray, ...values: any[]) {
  return strings.map((string, i) => [string, values[i]]).flat();
}

export function addSuggestion(suggestion: Suggestion) {
  setTimeout(() => suggestions.send([...suggestions.get(), suggestion]));
}
