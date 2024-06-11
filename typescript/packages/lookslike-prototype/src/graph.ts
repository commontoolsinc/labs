import { createElement } from "./ui.js";
import { run } from "./eval.js";
import { Recipe, RecipeNode } from "./data.js";

import { signal, config } from "@commontools/common-frp";
import { Context } from "./state.js";
import { doLLM, generateImage } from "./llm.js";
type Signal<T> = signal.SignalSubject<T>;

config.debug = true;

export function collectSymbols(recipe: Recipe) {
  const symbols = [] as { symbol: string; type: any }[];
  recipe.forEach((node) => {
    symbols.push({ symbol: node.id, type: node.outputType });
  });
  return symbols;
}

// inflate the RxJS network from a JSON graph definition
export function createRxJSNetworkFromJson(
  recipe: Recipe
): Context<Signal<any>> {
  // track all inputs and outputs
  const context = {
    inputs: {} as { [key: string]: { [key: string]: Signal<any> } },
    outputs: {} as { [key: string]: Signal<any> },
    cancellation: [] as (() => void)[]
  };

  // populate context namespace
  recipe.forEach((node) => {
    const nodeName = node.id;
    context.outputs[nodeName] = signal.state(null);

    // foreach input in the signature, create a placeholder cell
    if (node.in) {
      const inputs = node.in;
      context.inputs[nodeName] = {};
      for (const inputName in inputs) {
        context.inputs[nodeName][inputName] = signal.state(null);
      }
    }
  });

  // set up reactive bindings based on edges
  recipe.forEach((node) => {
    if (node.in) {
      const inputs = node.in;
      for (const inputName in inputs) {
        const [sourceContext, sourceNode] = inputs[inputName];
        if (sourceContext !== ".") throw Error("remote refs not allowed (yet)");
        const source = context.outputs[sourceNode];
        const target = context.inputs[node.id][inputName];

        if (!source || !target) {
          debugger;
          throw Error(
            `source or target not found: ${sourceNode} -> ${node.id}.${inputName}`
          );
        }

        const cancel = signal.effect([source], (value) => {
          target.send(value);
        });

        context.cancellation.push(cancel);
      }
    }
  });

  // process node definitions and set up reactive logic
  recipe.forEach(async (node) => {
    const inputObservables: Signal<any>[] = [];
    // const inputs = {} as { [key: string]: Signal<any> };

    for (const inputName in node.in) {
      const outputName = node.in[inputName][1];
      if (context.outputs[outputName]) {
        inputObservables.push(context.outputs[outputName]);
        // inputs[inputName] = context.outputs[outputName];
      }
    }

    // const initial = Object.entries(inputs).map(([k, v]) => [k, v.get()])
    // if (initial.every(([_k, v]) => v !== null)) {
    //   await executeNode(node, Object.fromEntries(initial), context.outputs)
    // }

    if (inputObservables.length === 0) {
      await executeNode(node, {}, context.outputs);
    }

    const allInputs = signal.computed(inputObservables, (...values) => {
      // make an object out of node.in and the values
      const inputs = Object.entries(node.in).reduce(
        (acc, [k, [_, v]], idx) => {
          acc[k] = values[idx];
          return acc;
        },
        {} as { [key: string]: any }
      );

      return inputs;
    });

    console.log("BOUND INPUTS", node.id, node.in, allInputs);

    const cancel = signal.effect([allInputs], async (values) => {
      // do not execute if any of the inputs are null
      // TODO: this is a symptom of modelling some invalid states
      if (Object.values(values).some((v) => v === null)) {
        return;
      }

      await executeNode(node, values, context.outputs);
    });
    context.cancellation.push(cancel);
  });

  return context;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeNode(
  node: RecipeNode,
  inputs: { [key: string]: any },
  outputs: { [key: string]: SignalSubject<any> }
) {
  console.log("EXECUTE NODE", node.id, inputs);
  const { contentType } = node;
  if (contentType === "text/javascript" && typeof node.body === "string") {
    const result = await run(node.id, node.body, inputs);
    outputs[node.id].send(result);
  } else if (contentType === "application/json+vnd.common.ui") {
    const renderedTemplate = createElement(node.body, inputs);
    outputs[node.id].send(renderedTemplate);
  } else if (
    contentType === "application/json+vnd.common.fetch" &&
    typeof node.body === "string"
  ) {
    const url = node.body;
    const response = await fetch(url);
    const data = await response.json();
    outputs[node.id].send(data);
  } else if (contentType === "application/json+vnd.common.llm") {
    const response = await doLLM(inputs.prompt, "", undefined);
    const data = response?.choices[0].message.content;
    outputs[node.id].send(data);
  } else if (contentType === "application/json+vnd.common.image") {
    const response = await generateImage(inputs.prompt);
    outputs[node.id].send(response);
  }
}
