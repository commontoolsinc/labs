import { BehaviorSubject, combineLatest } from 'rxjs';
import { createElement } from './ui';
import { prepare, run, serializationBoundary } from './eval';
import { Recipe, RecipeNode } from './data';

export const system = {
  get: (key: string) => {
    if (key === 'todos') {
      return serializationBoundary([
        { label: 'Buy groceries', checked: false },
        { label: 'Vacuum house', checked: true },
        { label: 'Learn RxJS', checked: false }
      ]);
    }

    if (key === 'emails') {
      return serializationBoundary([
        { subject: 'Meeting', from: 'John', date: '2020-01-01', read: false },
        { subject: 'Lunch', from: 'Jane', date: '2020-01-02', read: true },
        { subject: 'Dinner', from: 'Joe', date: '2020-01-03', read: false }
      ])
    }

    return [];
  }
};

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

        source.subscribe(value => {
          target.next(value);
        });
      }
    }
  });

  // process node definitions and set up reactive logic
  recipe.forEach(node => {
    if (!node.body) return;
    const nodeName = node.id;
    const { contentType } = node;


    const inputs = node.in;
    const inputObservables = [];

    for (const inputName in inputs) {
      if (context.outputs[inputName]) {
        inputObservables.push(context.outputs[inputName]);
      }
    }

    if (inputObservables.length === 0) {
      executeNode(node, {}, context.outputs)
    }

    combineLatest(inputObservables).subscribe(values => {
      const inputValues = values.reduce((acc, value, index) => {
        const key = Object.keys(inputs)[index];
        acc[key] = value;
        return acc;
      }, {});

      executeNode(node, inputValues, context.outputs)
    });
  });

  return context;
}

function executeNode(node: RecipeNode, inputs: { [key: string]: any }, outputs: { [key: string]: BehaviorSubject<any> }) {
  const { contentType } = node;
  if (contentType === 'text/javascript' && typeof node.body === 'string') {
    const module = prepare(node.body);
    const result = run(module, system, inputs);
    outputs[node.id].next(result);
  } else if (contentType === 'application/json+vnd.common.ui') {
    const renderedTemplate = createElement(node.body, inputs);
    outputs[node.id].next(renderedTemplate);
  }
}
