import { BehaviorSubject, combineLatest, filter } from 'rxjs';
import { createElement } from './ui';
import { prepare, run } from './eval';
import { Recipe, RecipeNode } from './data';
import { snapshot, system } from './state';

export function collectSymbols(recipe: Recipe) {
  const symbols = [] as { symbol: string, type: any }[];
  recipe.forEach(node => {
    symbols.push({ symbol: node.id, type: node.outputType })
  });
  return symbols;
}

// inflate the RxJS network from a JSON graph definition
export function createRxJSNetworkFromJson(recipe: Recipe) {
  // track all inputs and outputs
  const context = {
    inputs: {} as { [key: string]: { [key: string]: BehaviorSubject<any> } },
    outputs: {} as { [key: string]: BehaviorSubject<any> }
  };

  // populate context namespace
  recipe.forEach(node => {
    const nodeName = node.id;
    context.outputs[nodeName] = new BehaviorSubject(null);

    // foreach input in the signature, create a placeholder cell
    if (node.in) {
      const inputs = node.in;
      context.inputs[nodeName] = {};
      for (const inputName in inputs) {
        context.inputs[nodeName][inputName] = new BehaviorSubject(null);
      }
    }
  });

  // set up reactive bindings based on edges
  recipe.forEach(node => {
    if (node.in) {
      const inputs = node.in;
      for (const inputName in inputs) {
        const [sourceContext, sourceNode] = inputs[inputName];
        if (sourceContext !== '.') throw Error('remote refs not allowed (yet)')
        const source = context.outputs[sourceNode];
        const target = context.inputs[node.id][inputName];

        source.pipe(filter(value => value != null)).subscribe(value => {
          target.next(value);
        });
      }
    }
  });

  // process node definitions and set up reactive logic
  recipe.forEach(async node => {
    if (!node.body) return;
    const inputObservables = [];
    const inputs = {} as { [key: string]: BehaviorSubject<any> };

    for (const inputName in node.in) {
      const outputName = node.in[inputName][1];
      if (context.outputs[outputName]) {
        inputObservables.push(context.outputs[outputName].pipe(filter(value => value !== null)));
        inputs[inputName] = context.outputs[outputName];
      }
    }

    const initial = Object.entries(inputs).map(([k, v]) => [k, v.getValue()])
    if (initial.every(([_k, v]) => v !== null)) {
      await executeNode(node, Object.fromEntries(initial), context.outputs)
    }

    combineLatest(inputObservables).subscribe(async values => {
      const inputValues = values.reduce((acc, value, index) => {
        const key = Object.keys(inputs)[index];
        acc[key] = value;
        return acc;
      }, {});

      await executeNode(node, inputValues, context.outputs)
    });
  });

  return context;
}

async function executeNode(node: RecipeNode, inputs: { [key: string]: any }, outputs: { [key: string]: BehaviorSubject<any> }) {
  const { contentType } = node;
  if (contentType === 'text/javascript' && typeof node.body === 'string') {
    const module = prepare(node.body);
    const result = await run(module, system, inputs);
    outputs[node.id].next(result);
  } else if (contentType === 'application/json+vnd.common.ui') {
    const renderedTemplate = createElement(node.body, inputs);
    outputs[node.id].next(renderedTemplate);
  }
}
