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
  const data$ = new BehaviorSubject({ name: "", stats: {} });

  const ui$ = render$.pipe(
    ui(
      "combinedData",
      html`<div>
        <label>Name:</label>
        <span>{{data.name}}</span>
        <table>
          <tr>
            <th>Strength:</th>
            <td>{{data.stats.str}}</td>
          </tr>
          <tr>
            <th>Dexterity:</th>
            <td>{{data.stats.dex}}</td>
          </tr>
          <tr>
            <th>Constitution:</th>
            <td>{{data.stats.con}}</td>
          </tr>
          <tr>
            <th>Intelligence:</th>
            <td>{{data.stats.int}}</td>
          </tr>
          <tr>
            <th>Wisdom:</th>
            <td>{{data.stats.wis}}</td>
          </tr>
          <tr>
            <th>Charisma:</th>
            <td>{{data.stats.cha}}</td>
          </tr>
        </table>
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
