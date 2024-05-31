import { BehaviorSubject, combineLatest } from 'rxjs';
import { createElement } from './ui';

function serializationBoundary(obj) {
  console.log('forwarding data', obj)
  return JSON.parse(JSON.stringify(obj));
}

export const system = {
  get: (key) => {
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
export function createRxJSNetworkFromJson(graph) {
  // track all inputs and outputs
  const context = {
    inputs: {},
    outputs: {}
  };

  // populte context namespace
  graph.nodes.forEach(node => {
    if (!node.definition) return;
    const nodeName = node.definition.name;
    context.outputs[nodeName] = new BehaviorSubject(null);

    // foreach input in the signature, create a subject
    if (node.definition.signature) {
      const { inputs } = node.definition.signature;
      context.inputs[nodeName] = {};
      for (const inputName in inputs) {
        context.inputs[nodeName][inputName] = new BehaviorSubject(null);
      }
    }
  });

  // set up reactive bindings based on edges
  graph.edges.forEach(edge => {
    const [source, target] = Object.entries(edge)[0];
    const sourceSubject = context.outputs[source];
    const targetSubject = context.inputs[target[0]][target[1]];

    sourceSubject.subscribe(value => {
      targetSubject.next(value);
    });
  });

  // process node definitions and set up reactive logic
  graph.nodes.forEach(node => {
    if (!node.definition) return;
    const nodeName = node.definition.name;
    const { contentType, body, signature } = node.definition;

    if (contentType === 'text/javascript') {
      // Evaluate the JavaScript content and bind it to the subject
      // collect inputs and pass to functions
      const inputs = {};
      for (const inputName in signature.inputs) {
        inputs[inputName] = context.inputs[nodeName][inputName].getValue();
      }

      const func = new Function('system', 'inputs', body);
      const result = func(system, inputs);
      context.outputs[nodeName].next(serializationBoundary(result));
    } else if (contentType === 'application/json+vnd.common.ui') {
      // Set up template rendering
      const { inputs } = signature;
      const inputObservables = [];

      for (const inputName in inputs) {
        if (context.outputs[inputName]) {
          inputObservables.push(context.outputs[inputName]);
        }
      }

      combineLatest(inputObservables).subscribe(values => {
        const inputValues = values.reduce((acc, value, index) => {
          const key = Object.keys(inputs)[index];
          acc[key] = value;
          return acc;
        }, {});

        const renderedTemplate = createElement(node.definition.body, inputValues);
        context.outputs[nodeName].next(renderedTemplate);
      });
    }
  });

  return context;
}
