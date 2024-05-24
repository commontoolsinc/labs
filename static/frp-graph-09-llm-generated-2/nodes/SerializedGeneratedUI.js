import {
  mergeMap,
  map,
  fromEvent,
  distinct,
  distinctUntilChanged,
  from,
  of,
  filter,
  combineLatest,
  debounceTime,
  share,
  tap,
  Subject,
  BehaviorSubject,
} from "https://cdn.jsdelivr.net/npm/rxjs@7.8.1/+esm";
import { render, html, debug, log, state, ui } from "../render.js";
import { connect, ground } from "../connect.js";
import { imagine } from "../imagine.js";

function describeField(key, { kind, description }) {
  return `[\`${key}\`: ${kind}, ${description ? description : ""}]`
}

export function SerializedGeneratedUI(
  id,
  { inputs, outputs, contentType, body },
) {
  const all = { ...inputs, ...outputs }

  id = id.toLowerCase().replace(/ /g, "-");

  const inputs$ = Object.keys(inputs).reduce((acc, key) => {
    acc[key] = new BehaviorSubject(inputs[key].shape.default);
    return acc;
  }, {});


  // map over state and create a new BehaviorSubject for each key
  const outputs$ = Object.keys(outputs).reduce((acc, key) => {
    acc[key] = new BehaviorSubject(outputs[key].shape.default);
    return acc;
  }, {});

  // concat all inputs and outputs into one object
  const state$ = { ...inputs$, ...outputs$ };

  inputs$.prompt = inputs$.prompt || new BehaviorSubject("");
  inputs$.render = new Subject();
  const html$ = new BehaviorSubject("");

  const fieldDescriptions = Object.keys(all).filter(k => k !== 'render' && k !== 'prompt').map(key => describeField(key, all[key].shape)).join(", ");

  const generatedHtml$ = inputs$.prompt.pipe(map(p => `${p}\n\n The following fields are available: ${fieldDescriptions}`), imagine(id), tap(debug));

  const ui$ = inputs$.render.pipe(
    filter(() => html$.getValue() !== ""),
    map(() => render(id, html$.getValue(), state(state$))),
  );

  Object.keys(inputs$).forEach((key) => {
    connect(inputs$[key], inputs$.render);
  });

  connect(html$, inputs$.render);
  connect(generatedHtml$, html$);

  return {
    in: {
      ...inputs$,
    },
    out: {
      ui: ui$,
      html: html$,
      ...outputs$,
    },
  };
}
