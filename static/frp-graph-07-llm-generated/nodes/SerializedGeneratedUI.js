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

export function SerializedGeneratedUI(
  id,
  { inputs, outputs, contentType, body },
) {
  const inputs$ = Object.keys(inputs).reduce((acc, key) => {
    acc[key] = new BehaviorSubject(inputs[key].shape.default);
    return acc;
  }, {});

  inputs$.render = new Subject();
  const html$ = new BehaviorSubject("");

  // map over state and create a new BehaviorSubject for each key
  const state$ = Object.keys(outputs).reduce((acc, key) => {
    acc[key] = new BehaviorSubject(outputs[key].shape.default);
    return acc;
  }, {});

  const generatedHtml$ = inputs$.prompt.pipe(imagine(id), tap(debug));

  const ui$ = inputs$.render.pipe(
    filter(() => html$.getValue() !== ""),
    map(() => render(id, html$.getValue(), state(state$))),
  );

  Object.keys(state$).forEach((key) => {
    connect(state$[key], inputs$.render);
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
      ...state$,
    },
  };
}
