import { signal } from "@commontools/common-frp";
import { directive } from "lit/directive.js";
import { AsyncDirective } from "lit/async-directive.js";
import { state } from "lit/decorators.js";
import { Cell } from "@commontools/common-runner";

class WatchCellDirective<T> extends AsyncDirective {
  #cancel: (() => void) | undefined = undefined;

  isWatching = true;

  override render(signal: Cell<T>) {
    this.#cancel?.();
    this.#cancel = signal.sink((v: any) => {
      if (this.isWatching) {
        this.setValue(signal.getAsProxy());
      }
    });
    return signal.getAsProxy();
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
