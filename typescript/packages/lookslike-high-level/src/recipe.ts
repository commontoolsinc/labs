import { signal, stream } from "@commontools/common-frp";
import { isSignal } from "@commontools/common-frp/signal";

export const ID = Symbol("ID");

export type RecipeInputs = {
  [key: string]: any;
};

export type Bindings = {
  [key: string]: signal.Signal<any> | stream.Stream<any>;
};

export type InstantiatedRecipe = {
  [ID]: number;
} & Bindings;

// Readwrite signals are inputs that are passed through to the output
export type Recipe = (inputs: RecipeInputs) => InstantiatedRecipe;

let id = 0;

export const recipe = (impl: (inputs: Bindings) => Bindings): Recipe => {
  return (inputs: Bindings) => {
    const inputsAsSignals = Object.fromEntries(
      Object.entries(inputs).map(([key, value]) => [
        key,
        isSignal(value) ? value : signal.state(value),
      ])
    );
    const outputs = impl(inputsAsSignals);
    return { [ID]: id++, ...outputs };
  };
};
