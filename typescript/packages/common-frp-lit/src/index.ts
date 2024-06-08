import { signal } from "@commontools/common-frp";
import { directive } from "lit/directive.js";
import { AsyncDirective } from "lit/async-directive.js";

const {state, effect} = signal;

class WatchDirective extends AsyncDirective {
  #cancel: (() => void) | undefined = undefined;
  #isWatching = state(true);

  override render(signal: any) {
    this.#cancel?.();
    this.#cancel = effect([this.#isWatching, signal], (isWatching, value) => {
      if (isWatching) {
        this.setValue(value);
      }
    });
    return signal.get();
  }

  protected override disconnected(): void {
    this.#isWatching.send(false);
  }

  protected override reconnected(): void {
    this.#isWatching.send(true);
  }
}

/**
 * Renders a signal and subscribes to it, updating the part when the signal
 * changes.
 */
export const watch = directive(WatchDirective);