import {
  distinctUntilChanged,
  tap,
  Subject,
} from "https://cdn.jsdelivr.net/npm/rxjs@7.8.1/+esm";
import { applyPolicy } from "./policy.js";

export function connect(output, input) {
  output
    .pipe(
      distinctUntilChanged(),
      applyPolicy(),
      tap((v) => input.next(v)),
      // share(),
    )
    .subscribe();
}

export function ground(output) {
  connect(output, new Subject());
}
