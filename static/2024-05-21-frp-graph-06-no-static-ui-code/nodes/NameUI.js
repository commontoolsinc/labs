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

export function NameUI() {
  const render$ = new Subject();
  const name$ = new BehaviorSubject("");

  const ui$ = render$.pipe(
    ui(
      "nameForm",
      html`<div>
        <label for="name">Character Name:</label>
        <input type="text" v-model="name" />
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
      name: name$,
      ui: ui$,
    },
  };
}
