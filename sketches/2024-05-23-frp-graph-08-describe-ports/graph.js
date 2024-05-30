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
import { CodeNode } from "./nodes/CodeNode.js";

const descriptionUI = SerializedGeneratedUI("description", {
  inputs: {
    prompt: {
      shape: {
        kind: "string",
        default: "",
      },
    },
  },
  outputs: {
    description: {
      shape: {
        kind: "string",
        default: "A datatable.",
      }
    }
  }
});

const tableDimensionsUI = SerializedGeneratedUI("dimensions", {
  inputs: {
    prompt: {
      shape: {
        kind: "string",
        default: "sliders",
      },
    },
  },
  outputs: {
    rows: { shape: { kind: "number", default: 2, description: "the number of rows of data to generate" } },
    cols: { shape: { kind: "number", default: 2, description: "the number of fields to generate for each row" } },
  },
  contentType: "GeneratedUI",
});

const dataTableUI = SerializedGeneratedUI("table", {
  inputs: {
    prompt: {
      shape: {
        kind: "string",
        default: "",
      },
    },
    fields: { shape: { kind: "array(string)", default: [], description: "the column names" } },
    data: { shape: { kind: "array(object)", default: [], description: "data records to display" } },
  },
  outputs: {},
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
    result: { shape: { kind: "array(string)", default: [], description: "generated field names" } },
  },
  contentType: "LLMResult",
});


const dataTablePrompt$ = CodeNode({
  inputs: {
    description: {
      shape: {
        kind: "string",
        default: "",
      }
    },
    fields: {
      shape: {
        kind: "array",
        default: [],
        description: "The fields to generate."
      }
    }
  },
  outputs: {
    prompt: {
      shape: {
        kind: "string",
        default: "A datatable.",
      }
    }
  },
  fn: ({ description, fields }) => ({
    prompt: `${description}.

    Here are the field names: ${JSON.stringify(Object.values(fields), null, 2)}`
  })
})

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
        default: `Generate {{rows}} fictional data records with rtheu following fields: {{fields}}.`,
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
    result: { shape: { kind: "array", default: [], description: "the generated data records" } },
  },
  contentType: "LLMResult",
});

ground(descriptionUI.out.ui);
ground(tableDimensionsUI.out.ui);
ground(dataTableUI.out.ui);

connect(tableDimensionsUI.out.cols, generatedFieldNames$.in.fields);
connect(generatedFieldNames$.out.result, generatedData$.in.fields);
connect(tableDimensionsUI.out.rows, generatedData$.in.rows);
connect(generatedFieldNames$.out.result, dataTableUI.in.fields);
connect(generatedData$.out.result, dataTableUI.in.data);

connect(generatedData$.out.result, dataTableUI.in.render);

connect(descriptionUI.out.description, dataTablePrompt$.in.description);
connect(generatedFieldNames$.out.result, dataTablePrompt$.in.fields)
connect(dataTablePrompt$.out.prompt, dataTableUI.in.prompt);
dataTablePrompt$.out.prompt.subscribe(console.log);
