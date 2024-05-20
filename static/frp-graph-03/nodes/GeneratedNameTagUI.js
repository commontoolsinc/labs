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
import { ground } from "../connect.js";
import { imagine } from "../imagine.js";

export function GeneratedNameTagUI() {
  const render$ = new Subject();
  const generate$ = new Subject();
  const name$ = new BehaviorSubject("");
  const id = "nameTag";

  const html$ = new BehaviorSubject("");
  ground(
    generate$.pipe(
      imagine(
        id,
        `A header displaying the character's name in extremely fancy rainbowcolor animated text. Assume it is called \`name\`.`,
      ),
      tap(debug),
      tap((html) => {
        html$.next(html);
        render$.next();
      }),
    ),
  );
  const ui$ = render$.pipe(
    map(() => render(id, html$.getValue(), state({ name: name$ }))),
  );

  return {
    in: {
      render: render$,
      generate: generate$,
      name: name$,
    },
    out: {
      name: name$,
      ui: ui$,
      html: html$,
    },
  };
}
