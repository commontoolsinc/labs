import { signal, stream } from "@commontools/common-frp";
import { isSignal } from "@commontools/common-frp/signal";

// Should be Symbol("ID") or so, but this makes repeat() use these when
// iterating over recipes.
export const ID = "id";
export const TYPE = Symbol("type");

export type RecipeInputs = {
  [key: string]: any;
};

// TODO: `any` is here to support returning constant vdoms. Let's capture that
// as proper constant values in the future & disallow this on the inputs.
export type Bindings = {
  [key: string]: signal.Signal<any> | stream.Stream<any> | any;
};

export type InstantiatedRecipe = {
  [ID]: number;
  [TYPE]: string;
} & Bindings;

// Readwrite signals are inputs that are passed through to the output
export type Recipe = (inputs: RecipeInputs) => InstantiatedRecipe;

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
