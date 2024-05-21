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

export function PortraitUI() {
  const render$ = new Subject();
  const img$ = new BehaviorSubject("");

  const ui$ = render$.pipe(
    ui(
      "portrait",
      html`<div>
        <img width="256px" height="256px" v-effect="$el.src = img" />
      </div>`,
      state({ img: img$ }),
    ),
  );

  return {
    in: {
      render: render$,
      img: img$,
    },
    out: {
      ui: ui$,
    },
  };
}
