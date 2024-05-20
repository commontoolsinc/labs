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

export function GeneratedBackstoryUI() {
  const render$ = new Subject();
  const generate$ = new Subject();
  const backstory$ = new BehaviorSubject("");
  const id = "backstoryPanel";

  const html$ = new BehaviorSubject("");
  ground(
    generate$.pipe(
      imagine(id, `A paragraph containing a character's \`backstory\`.`),
      tap(debug),
      tap((html) => {
        html$.next(html);
        render$.next();
      }),
    ),
  );
  const ui$ = backstory$.pipe(
    tap((v) => console.log("rendering story", v)),
    map(() => render(id, html$.getValue(), state({ backstory: backstory$ }))),
  );

  return {
    in: {
      render: render$,
      generate: generate$,
      backstory: backstory$,
    },
    out: {
      backstory: backstory$,
      ui: ui$,
      html: html$,
    },
  };
}
