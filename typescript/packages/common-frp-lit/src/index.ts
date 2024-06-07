import { signal } from "@commontools/common-frp";
import {directive} from 'lit/directive.js';
import {AsyncDirective} from 'lit/async-directive.js';

const {state, effect} = signal;

class WatchDirective extends AsyncDirective {
  #isWatching

  constructor(part: any) {
    super(part);
    this.#isWatching = state(true);
  }

  override render(signal: any) {
    effect(this.#isWatching, isWatching => {
      if (isWatching) {
        this.setValue(signal.get());
      }
    });
    return signal.get();
  }

  protected override disconnected(): void {
    this.#isWatching.send(false)
  }

  protected override reconnected(): void {
    this.#isWatching.send(true)
  }
}

/**
 * Renders a signal and subscribes to it, updating the part when the signal
 * changes.
 */
export const watch = directive(WatchDirective)