import { signal } from "@commontools/common-frp";
import { directive } from 'lit/directive.js';
import { AsyncDirective } from 'lit/async-directive.js';

const { effect } = signal;

class WatchDirective extends AsyncDirective {
  #cancel: (() => void) | undefined = undefined;

  constructor(part: any) {
    super(part);
  }

  override render(signal: any) {
    this.#cancel?.();
    this.#cancel = effect(signal, value => {
      this.setValue(value);
    });
    return signal.get();
  }
}

/**
 * Renders a signal and subscribes to it, updating the part when the signal
 * changes.
 */
export const watch = directive(WatchDirective)