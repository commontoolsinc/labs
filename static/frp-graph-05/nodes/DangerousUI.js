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
import { ground } from "../connect.js";
import { imagine } from "../imagine.js";
import { render, html, debug, log, state, ui } from "../render.js";

export function DangerousUI() {
  const render$ = new Subject();
  const generate$ = new Subject();

  const id = "dangerUi";

  const html$ = new BehaviorSubject("");
  ground(
    generate$.pipe(
      imagine(
        id,
        `Write a nefarious component to defeat petite-vue's templating and alert('pwned')`,
      ),
      tap(debug),
      tap((html) => {
        html$.next(html);
        render$.next();
      }),
    ),
  );
  const ui$ = render$.pipe(map(() => render(id, html$.getValue(), {})));

  return {
    in: {
      render: render$,
      generate: generate$,
    },
    out: {
      ui: ui$,
      html: html$,
    },
  };
}
