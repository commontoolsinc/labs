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

export function CombinedDataUI() {
  const render$ = new Subject();
  const data$ = new BehaviorSubject({});

  const ui$ = render$.pipe(
    ui(
      "combinedData",
      html`<div>
        <label>Name:</label>
        <span>{{data.name}}</span>
        <label>Cursor:</label>
        <div
          style="width: 100px; height: 100px; position: relative;"
          class="hover"
        >
          {{data.cursor.x}}, {{data.cursor.y}}
          <div
            v-effect="$el.style.left = data.cursor.x + 'px'; $el.style.top = data.cursor.y + 'px';"
            style="position: absolute; width: 4px; height: 4px; background: red;"
          ></div>
        </div>
      </div>`,
      state({ data: data$ }),
    ),
  );

  return {
    in: {
      render: render$,
      data: data$,
    },
    out: {
      ui: ui$,
    },
  };
}
