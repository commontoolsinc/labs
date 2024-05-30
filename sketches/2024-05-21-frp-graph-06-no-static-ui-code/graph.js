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
import { SerializedGeneratedUI } from "./nodes/SerializedGeneratedUI.js";
import { SerializedLLMNode } from "./nodes/SerializedLLMNode.js";

const tableDimensionsUI = SerializedGeneratedUI("dimensions", {
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
  contentType: "GeneratedUI",
});

const dataTableUI = SerializedGeneratedUI("table", {
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
  contentType: "GeneratedUI",
});

const generatedFieldNames$ = SerializedLLMNode({
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
  contentType: "LLMResult",
});

const dataTablePrompt$ = generatedFieldNames$.out.result.pipe(
  map((d) => {
    return `A datatable that displays records from a database schema. Data will be in \`data\` as a list of JSON records. The columns of the table will be in \`fields\` as a list of strings.

Here are the fields: ${JSON.stringify(d, null, 2)};`;
  }),
);

const generatedData$ = SerializedLLMNode({
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
  contentType: "LLMResult",
});

ground(tableDimensionsUI.out.ui);
ground(dataTableUI.out.ui);

connect(tableDimensionsUI.out.cols, generatedFieldNames$.in.fields);
connect(generatedFieldNames$.out.result, generatedData$.in.fields);
connect(tableDimensionsUI.out.rows, generatedData$.in.rows);
connect(generatedFieldNames$.out.result, dataTableUI.out.fields);
connect(generatedData$.out.result, dataTableUI.out.data);

connect(generatedData$.out.result, dataTableUI.in.render);

connect(dataTablePrompt$.out.result, dataTableUI.in.prompt);
