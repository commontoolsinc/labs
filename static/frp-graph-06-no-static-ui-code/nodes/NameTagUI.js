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

export function NameTagUI() {
  const render$ = new Subject();
  const name$ = new BehaviorSubject("");

  const ui$ = render$.pipe(
    ui(
      "nameTag",
      html`<div>
        <h1>{{name}}</h1>
      </div>`,
      state({ name: name$ }),
    ),
  );

  return {
    in: {
      render: render$,
      name: name$,
    },
    out: {
      ui: ui$,
    },
  };
}
