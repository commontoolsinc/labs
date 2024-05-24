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

export function BehaviourNode(constant) {
  const value$ = new BehaviorSubject(constant);

  return {
    in: {
      value: value$,
    },
    out: {
      value: value$,
    },
  };
}
