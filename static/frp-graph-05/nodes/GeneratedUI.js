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
import { connect } from "../connect.js";
import { imagine } from "../imagine.js";

export function GeneratedUI(id, prompt, localState) {
  const render$ = new Subject();
  const generate$ = new BehaviorSubject(prompt);
  const html$ = new BehaviorSubject("");

  // map over state and create a new BehaviorSubject for each key
  const state$ = Object.keys(localState).reduce((acc, key) => {
    acc[key] = new BehaviorSubject(localState[key]);
    return acc;
  }, {});

  const generatedHtml$ = generate$.pipe(imagine(id), tap(debug));

  const ui$ = render$.pipe(
    map(() => render(id, html$.getValue(), state(state$))),
  );

  // connect(backstory$, render$);
  connect(html$, render$);
  connect(generatedHtml$, html$);

  return {
    in: {
      render: render$,
      generate: generate$,
    },
    out: {
      ui: ui$,
      html: html$,
      ...state$,
    },
  };
}
