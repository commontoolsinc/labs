import { createElement } from "./ui.js";
import { run } from "./eval.js";
import { Recipe, RecipeNode } from "./data.js";

import { signal, config } from "@commontools/common-frp";
import { Context } from "./state.js";
import { generateImage, streamLlm } from "./llm.js";
import {
  CONTENT_TYPE_CLOCK,
  CONTENT_TYPE_EVENT,
  CONTENT_TYPE_FETCH,
  CONTENT_TYPE_IMAGE,
  CONTENT_TYPE_JAVASCRIPT,
  CONTENT_TYPE_LLM,
  CONTENT_TYPE_UI
} from "./contentType.js";
import { SignalSubject } from "../../common-frp/lib/signal.js";
type Signal<T> = signal.SignalSubject<T>;

// config.debug = true;

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

  console.log("EXECUTE NODE about to re-run entire graph");
  // process node definitions and set up reactive logic
  recipe.forEach(async (node) => {
    const inputObservables: Signal<any>[] = [];
    const inputSignals: { [key: string]: Signal<any> } = {};

    for (const inputName in node.in) {
      const outputName = node.in[inputName][1];
      if (context.outputs[outputName]) {
        inputObservables.push(context.outputs[outputName]);
        inputSignals[inputName] = context.outputs[outputName];
      }
    }

    if (inputObservables.length === 0) {
      console.log("EXECUTE NODE Running node on mount", node.id);
      await executeNode(node, {}, context.outputs, inputSignals);
      if (node.contentType !== CONTENT_TYPE_JAVASCRIPT) {
        return;
      }
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

      console.log(
        "EXECUTE NODE Re-running node because inputs changed",
        node.id,
        values
      );
      await executeNode(node, values, context.outputs, inputSignals);
    });
    context.cancellation.push(cancel);
  });

  return context;
}

const intervals = {} as { [key: string]: NodeJS.Timeout };

async function executeNode(
  node: RecipeNode,
  inputs: { [key: string]: any },
  outputs: { [key: string]: SignalSubject<any> },
  inputSignals: { [key: string]: Signal<any> }
) {
  console.log("EXECUTE NODE", node.id, inputs);
  const { contentType } = node;

  switch (contentType) {
    case CONTENT_TYPE_JAVASCRIPT: {
      if (typeof node.body !== "string") {
        throw new Error("Expected a string");
      }
      const result = await run(node.id, node.body, inputs);
      outputs[node.id].send(result);
      break;
    }
    case CONTENT_TYPE_UI: {
      const template = createElement(node.body, inputSignals);
      outputs[node.id].send(template);
      break;
    }
    case CONTENT_TYPE_FETCH: {
      if (typeof node.body !== "string") {
        throw new Error("Expected a string");
      }
      const url = node.body;
      const response = await fetch(url);
      const data = await response.json();
      outputs[node.id].send(data);
      break;
    }
    case CONTENT_TYPE_EVENT: {
      outputs[node.id].send(inputs);
      break;
    }
    case CONTENT_TYPE_CLOCK: {
      clearInterval(intervals[node.id]);
      let x = 0;
      intervals[node.id] = setInterval(() => {
        x++;
        outputs[node.id].send(x);
      }, 1000);
      break;
    }
    case CONTENT_TYPE_LLM: {
      const response = await streamLlm(
        JSON.stringify(inputs.prompt),
        "",
        (preview) => {
          outputs[node.id].send(preview);
        }
      );
      outputs[node.id].send(response);
      break;
    }
    case CONTENT_TYPE_IMAGE: {
      const response = await generateImage(JSON.stringify(inputs.prompt));
      outputs[node.id].send(response);
      break;
    }
  }
}
