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

export function GeneratedStatsUI() {
  const render$ = new Subject();
  const generate$ = new Subject();
  const attributes$ = {
    str: new BehaviorSubject(10),
    dex: new BehaviorSubject(10),
    con: new BehaviorSubject(10),
    int: new BehaviorSubject(10),
    wis: new BehaviorSubject(10),
    cha: new BehaviorSubject(10),
  };

  const id = "statsForm";

  const html$ = new BehaviorSubject("");
  ground(
    generate$.pipe(
      imagine(
        id,
        `UI with Sliders to adjust STR, DEX, CON, INT, WIS, CHA for the character, assume these are available as \`str\`, \`dex\`, \`con\`, \`int\`, \`wis\`, \`cha\` in the template.`,
      ),
      tap(debug),
      tap((html) => {
        html$.next(html);
        render$.next();
      }),
    ),
  );

  const ui$ = render$.pipe(
    map(() => render(id, html$.getValue(), state({ ...attributes$ }))),
  );

  return {
    in: {
      render: render$,
      generate: generate$,
    },
    out: {
      ui: ui$,
      html: html$,
      ...attributes$,
    },
  };
}
