import { createElement } from "./ui.js";
import { run } from "./eval.js";
import { Recipe, RecipeNode } from "./data.js";

import { Context, storage } from "./state.js";
import {
  CONTENT_TYPE_CLOCK,
  CONTENT_TYPE_EVENT,
  CONTENT_TYPE_FETCH,
  CONTENT_TYPE_IMAGE,
  CONTENT_TYPE_JAVASCRIPT,
  CONTENT_TYPE_LLM,
  CONTENT_TYPE_STORAGE,
  CONTENT_TYPE_UI
} from "./contentType.js";
import { combineLatest, Observable } from "rxjs";
import { Gem, gem, read, write } from "./gems.js";
import { generateImage, streamLlm } from "./agent/llm.js";

// config.debug = true;

export function collectSymbols(recipe: Recipe) {
  const symbols = [] as { symbol: string; type: any }[];
  recipe.forEach((node) => {
    symbols.push({ symbol: node.id, type: node.outputType });
  });
  return symbols;
}

// inflate the RxJS network from a JSON graph definition
export async function createRxJSNetworkFromJson(
  recipe: Recipe
): Promise<Context<Gem<any>>> {
  // track all inputs and outputs
  const context = {
    inputs: {} as {
      [key: string]: { [key: string]: Gem<any> };
    },
    outputs: {} as { [key: string]: Gem<any> },
    cancellation: [] as (() => void)[]
  };

  // populate context namespace
  recipe.forEach(async (node) => {
    const nodeName = node.id;
    context.outputs[nodeName] = gem(nodeName);

    // foreach input in the signature, create a placeholder cell
    if (node.in) {
      const inputs = node.in;
      context.inputs[nodeName] = {};
      for (const inputName in inputs) {
        context.inputs[nodeName][inputName] = undefined as any;
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
        context.inputs[node.id][inputName] = context.outputs[sourceNode];
      }
    }
  });

  console.log("EXECUTE NODE about to re-run entire graph");
  // process node definitions and set up reactive logic
  for (const node of recipe) {
    const inputObservables: Observable<any>[] = [];
    const inputSignals: { [key: string]: Gem<any> } = {};

    for (const inputName in node.in) {
      const outputName = node.in[inputName][1];
      if (context.outputs[outputName]) {
        inputObservables.push(context.outputs[outputName].data);
        inputSignals[inputName] = context.outputs[outputName];
      }
    }

    if (inputObservables.length === 0) {
      // const val = await read(gem(node.id));
      // if (!val) {
      console.log("EXECUTE NODE Running node on mount", node.id);
      await executeNode(node, {}, context.outputs, inputSignals);
      // }
      if (node.contentType !== CONTENT_TYPE_JAVASCRIPT) {
        continue;
      }
    }

    console.log("BOUND INPUTS", node.id, node.in);

    const sub = combineLatest(inputObservables).subscribe(async (values) => {
      if (values.some((v) => v === null)) {
        return;
      }

      console.log(
        "EXECUTE NODE Re-running node because inputs changed",
        node.id,
        values
      );
      await executeNode(node, values, context.outputs, inputSignals);
    });

    // context.cancellation.push(sub.unsubscribe);
  }

  return context;
}

const intervals = {} as { [key: string]: NodeJS.Timeout };

async function executeNode(
  node: RecipeNode,
  inputs: { [key: string]: any },
  outputs: { [key: string]: Gem<any> },
  inputSignals: { [key: string]: Gem<any> }
) {
  console.log("EXECUTE NODE", node.id, inputs);
  const { contentType } = node;

  switch (contentType) {
    case CONTENT_TYPE_JAVASCRIPT: {
      if (typeof node.body !== "string") {
        throw new Error("Expected a string");
      }
      const result = await run(node.id, node.body, inputs, node.evalMode);
      await write(outputs[node.id], result);
      break;
    }
    case CONTENT_TYPE_UI: {
      const template = createElement(node.body, inputSignals);
      await write(outputs[node.id], template);
      break;
    }
    case CONTENT_TYPE_FETCH: {
      if (typeof node.body !== "string") {
        throw new Error("Expected a string");
      }
      const url = node.body;
      const response = await fetch(url);
      const data = await response.json();
      await write(outputs[node.id], data);
      break;
    }
    case CONTENT_TYPE_EVENT: {
      await write(outputs[node.id], inputs);
      break;
    }
    case CONTENT_TYPE_CLOCK: {
      clearInterval(intervals[node.id]);
      let x = 0;
      intervals[node.id] = setInterval(async () => {
        x++;
        await write(outputs[node.id], x);
      }, 1000);
      break;
    }
    case CONTENT_TYPE_LLM: {
      const response = await streamLlm(
        JSON.stringify(inputs.prompt),
        "",
        async (preview) => {
          await write(outputs[node.id], preview);
        }
      );
      await write(outputs[node.id], response);
      break;
    }
    case CONTENT_TYPE_IMAGE: {
      const response = await generateImage(JSON.stringify(inputs.prompt));
      await write(outputs[node.id], response);
      break;
    }
    case CONTENT_TYPE_STORAGE: {
      // iterate over all values in inputs and pick first non-null value in functional style
      let value = Object.values(inputs).find((v) => v !== null);
      if (typeof node.body !== "string" || node.body.length === 0) {
        console.error("Invalid storage key", node.body);
        break;
      }

      if (value) {
        await storage.set(node.body, value);
      } else {
        value = await storage.get(node.body);
      }

      await write(outputs[node.id], value);
      break;
    }
  }
}
