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

export function Cursor() {
  const render$ = new Subject();
  const cursorPosition$ = new BehaviorSubject({ x: 0, y: 0 });

  const ui$ = render$.pipe(
    ui(
      "cursor",
      html`<div>
        <div
          v-effect="$el.style.backgroundColor = popup ? 'red' : 'blue';"
          style="width: 100px; height: 100px;"
          class="hover"
          @mouseenter="mouseEnter"
          @mousemove="mouseMove"
          @mouseleave="mouseLeave"
        >
          {{x}}, {{y}}
        </div>
      </div>`,
      state({
        popup: false,
        x: 0,
        y: 0,
        mouseEnter(event) {
          this.popup = true;
        },
        mouseLeave(event) {
          this.popup = false;
        },
        mouseMove(event) {
          // get position within element bounds
          this.x = event.offsetX;
          this.y = event.offsetY;
          cursorPosition$.next({ x: event.offsetX, y: event.offsetY });
        },
      }),
    ),
  );

  return {
    in: {
      render: render$,
    },
    out: {
      cursor: cursorPosition$,
      ui: ui$,
    },
  };
}
