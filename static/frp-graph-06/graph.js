import {
  combineLatest,
  debounceTime,
  delay,
  distinctUntilChanged,
  filter,
  from,
  fromEvent,
  map,
  mergeMap,
  BehaviorSubject,
  share,
  switchMap,
  tap,
} from "https://cdn.jsdelivr.net/npm/rxjs@7.8.1/+esm";
import { connect, ground } from "./connect.js";
import { doLLM, extractResponse, generateImage, grabJson } from "./llm.js";
import { BehaviourNode } from "./nodes/BehaviourNode.js";
import { SerializedGeneratedUI } from "./nodes/SerializedGeneratedUI.js";
import { GeneratedUI } from "./nodes/GeneratedUI.js";

const startButton = document.getElementById("startWorkflow");

function LLMNode(input$, inputPromptFn, inputSystemPromptFn) {
  return {
    out: {
      result: input$.pipe(
        debounceTime(1000),
        distinctUntilChanged(),
        switchMap((data) => {
          console.log("data", data);
          return from(doLLM(inputPromptFn(data), inputSystemPromptFn(data)));
        }),
        map(extractResponse),
        map(grabJson),
        share(),
      ),
    },
  };
}

function templateText(template, data) {
  return template.replace(/{{\s*([^{}\s]+)\s*}}/g, (match, key) => {
    return key in data ? data[key] : match;
  });
}

function SerializedLLMNode({ inputs, outputs }) {
  const inputs$ = Object.keys(inputs).reduce((acc, key) => {
    acc[key] = new BehaviorSubject(inputs[key].shape.default);
    return acc;
  }, {});

  const result$ = new BehaviorSubject({});

  const $llm = combineLatest(Object.values(inputs$))
    .pipe(
      debounceTime(1000),
      distinctUntilChanged(),
      switchMap((_) => {
        const snapshotInputs = Object.keys(inputs$).reduce((acc, key) => {
          acc[key] = inputs$[key].getValue();
          return acc;
        }, {});
        console.log("LLM", snapshotInputs);

        return from(
          doLLM(
            templateText(snapshotInputs.uiPrompt, snapshotInputs),
            templateText(snapshotInputs.systemPrompt, snapshotInputs),
          ),
        );
      }),
      map(extractResponse),
      map(grabJson),
      tap((result) => result$.next(result)),
      share(),
    )
    .subscribe();

  return {
    in: inputs$,
    out: {
      result: result$,
    },
  };
}

// {
//     inputs: {
//         text: { shape: { kind: 'string' } }
//     },
//     outputs: {
//         renderTree: { shape: { kind: { vdom: 'string' } } },
//         value: { shape: { kind: 'string' } }
//     },
//     contentType: 'text/javascript',
//     body: `...`
// }

const schemaConfigUI = SerializedGeneratedUI("dimensions", {
  inputs: {
    prompt: {
      shape: {
        kind: "string",
        default:
          "Two sliders to adjust the number of rows and columns in a theoretical database schema called rows and cols.",
      },
    },
    render: { shape: { kind: "unit" } },
  },
  outputs: {
    rows: { shape: { kind: "number", default: 2 } },
    cols: { shape: { kind: "number", default: 2 } },
  },
  contentType: "generated_ui",
  body: ``,
});

const dataUI = SerializedGeneratedUI("table", {
  inputs: {
    prompt: {
      shape: {
        kind: "string",
        default:
          "A datatable that displays records from a database schema. Data will be in `data` as a list of JSON records. The columns of the table will be in `fields` as a list of strings.",
      },
    },
    render: { shape: { kind: "unit" } },
  },
  outputs: {
    fields: { shape: { kind: "array", default: [] } },
    data: { shape: { kind: "array", default: [] } },
  },
  contentType: "generated_ui",
  body: ``,
});

const fields$ = SerializedLLMNode({
  inputs: {
    fields: {
      shape: {
        kind: "array",
      },
    },
    uiPrompt: {
      shape: {
        kind: "string",
        default: `Generate {{fields}} fields for a theoretical database schema.`,
      },
    },
    systemPrompt: {
      shape: {
        kind: "string",
        default:
          "Respond only with a list of fields in a JSON array, surrounded in a ```json``` block.",
      },
    },
  },
  outputs: {
    result: { shape: { kind: "array", default: [] } },
  },
});

// const fields$ = LLMNode(
//   schemaConfigUI.out.cols,
//   (fields) => `Generate ${fields} fields for a theoretical database schema.`,
//   () =>
//     "Respond only with a list of fields in a JSON array, surrounded in a ```json``` block.",
// );

const dataTablePrompt$ = fields$.out.result.pipe(
  map((d) => {
    return `A datatable that displays records from a database schema. Data will be in \`data\` as a list of JSON records. The columns of the table will be in \`fields\` as a list of strings.

Here are the fields: ${JSON.stringify(d, null, 2)};`;
  }),
);

const dataSpec$ = combineLatest([fields$.out.result, schemaConfigUI.out.rows]);

const data$ = SerializedLLMNode({
  inputs: {
    fields: {
      shape: {
        kind: "array",
      },
    },
    rows: {
      shape: {
        kind: "number",
      },
    },
    uiPrompt: {
      shape: {
        kind: "string",
        default: `Generate {{rows}} of data for a theoretical database schema with the following fields: {{fields}}.`,
      },
    },
    systemPrompt: {
      shape: {
        kind: "string",
        default:
          "Respond a plain JSON object mapping fields to values, surrounded in a ```json``` block.",
      },
    },
  },
  outputs: {
    result: { shape: { kind: "array", default: [] } },
  },
});

// const data$ = LLMNode(
//   dataSpec$,
//   ([fields, rows]) =>
//     `Generate ${rows} of data for a theoretical database schema with the following fields: ${fields}.`,
//   () =>
//     "Respond a plain JSON object mapping fields to values, surrounded in a ```json``` block.",
// );

ground(schemaConfigUI.out.ui);
ground(dataUI.out.ui);

connect(schemaConfigUI.out.cols, fields$.in.fields);
connect(fields$.out.result, data$.in.fields);
connect(schemaConfigUI.out.rows, data$.in.rows);
connect(fields$.out.result, dataUI.out.fields);
connect(data$.out.result, dataUI.out.data);

connect(data$.out.result, dataUI.in.render);

connect(dataTablePrompt$, dataUI.in.prompt);

// ground(
//   fromEvent(startButton, "click").pipe(
//     tap(() => {
//       // schemaConfigUI.in.generate.next();
//     }),
//     switchMap(() => data$),
//   ),
// );
