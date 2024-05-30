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
  share,
  switchMap,
  tap,
} from "https://cdn.jsdelivr.net/npm/rxjs@7.8.1/+esm";
import { connect, ground } from "./connect.js";
import { doLLM, extractResponse, generateImage, grabJson } from "./llm.js";
import { BehaviourNode } from "./nodes/BehaviourNode.js";
import { GeneratedUI } from "./nodes/GeneratedUI.js";

const startButton = document.getElementById("startWorkflow");

const schemaConfigUI = GeneratedUI(
  "schema",
  "Two sliders to adjust the number of rows and columns in a theoretical database schema called rows and cols.",
  { rows: 2, cols: 2 },
);

const dataUI = GeneratedUI(
  "table",
  "A datatable that displays records from a database schema. Data will be in `data` as a list of JSON records. The columns of the table will be in `fields` as a list of strings.",
  { fields: [], data: [] },
);

const fields$ = schemaConfigUI.out.cols.pipe(
  filter((v) => v > 0),
  debounceTime(1000),
  distinctUntilChanged(),
  switchMap((fields) => {
    console.log("fields", fields);
    return from(
      doLLM(
        `Generate ${fields} fields for a theoretical database schema.`,
        "Respond only with a list of fields in a JSON array, surrounded in a ```json``` block.",
      ),
    );
  }),
  map(extractResponse),
  map(grabJson),
  share(),
);

const data$ = combineLatest([fields$, schemaConfigUI.out.rows]).pipe(
  filter(([_, rows]) => rows > 0),
  debounceTime(1000),
  distinctUntilChanged(),
  switchMap(([fields, rows]) => {
    console.log("fields", fields);
    return from(
      doLLM(
        `Generate ${rows} of data for a theoretical database schema with the following fields: ${fields}.`,
        "Respond a plain JSON object mapping fields to values, surrounded in a ```json``` block.",
      ),
    );
  }),
  map(extractResponse),
  map(grabJson),
  share(),
);

ground(schemaConfigUI.out.ui);
ground(dataUI.out.ui);

connect(fields$, dataUI.out.fields);
connect(data$, dataUI.out.data);

connect(data$, dataUI.in.render);

connect(
  fields$.pipe(
    map((d) => {
      return `A datatable that displays records from a database schema. Data will be in \`data\` as a list of JSON records. The columns of the table will be in \`fields\` as a list of strings.

  Here are the fields: ${JSON.stringify(d, null, 2)};`;
    }),
  ),
  dataUI.in.generate,
);

ground(
  fromEvent(startButton, "click").pipe(
    tap(() => {
      schemaConfigUI.in.generate.next();
    }),
    switchMap(() => data$),
  ),
);
