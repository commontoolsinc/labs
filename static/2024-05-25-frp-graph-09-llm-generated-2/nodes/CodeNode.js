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
import { connect, ground } from "../connect.js";
import { snapshot } from "../state.js";
import { imagine } from "../imagine.js";

export function CodeNode({ inputs, outputs, fn }) {
  const all = { ...inputs, ...outputs }

  const inputs$ = Object.keys(inputs).reduce((acc, key) => {
    acc[key] = new BehaviorSubject(inputs[key].shape.default);
    return acc;
  }, {});


  // map over state and create a new BehaviorSubject for each key
  const outputs$ = Object.keys(outputs).reduce((acc, key) => {
    acc[key] = new BehaviorSubject(outputs[key].shape.default);
    return acc;
  }, {});

  Object.values(inputs$).forEach(input => {
    input.pipe(debounceTime(1000), map(_ => snapshot(inputs$)), map(fn), share()).subscribe(
      (value) => {
        Object.keys(value).forEach(key => {
          outputs$[key].next(value[key]);
        });
      }
    );
  })

  return {
    in: {
      ...inputs$,
    },
    out: {
      ...outputs$,
    }
  }
}
