import { directive } from "lit/directive.js";
import { AsyncDirective } from "lit/async-directive.js";
import { Cell } from "@commontools/common-runner";

const id = <T>(x: T) => x;

class WatchCellDirective<T> extends AsyncDirective {
  #cancel: (() => void) | undefined = undefined;

  isWatching = true;

  override render(signal: Cell<T>, mapFn: (v: T) => any = id) {
    this.#cancel?.();
    this.#cancel = signal.sink((v: any) => {
      if (this.isWatching) {
        this.setValue(mapFn(signal.getAsProxy()));
      }
    });
    return mapFn(signal.getAsProxy());
  }

  protected override disconnected(): void {
    this.isWatching = false;
  }

  protected override reconnected(): void {
    this.isWatching = true;
  }
}

/**
 * Renders a signal and subscribes to it, updating the part when the signal
 * changes.
 */
export const watchCell = directive(WatchCellDirective);
