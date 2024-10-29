import { directive } from "lit/directive.js";
import { AsyncDirective } from "lit/async-directive.js";
import { RendererCell } from "@commontools/common-runner";

const id = <T>(x: T) => x;

class WatchCellDirective<T> extends AsyncDirective {
  #cancel: (() => void) | undefined = undefined;

  isWatching = true;

  override render(signal: RendererCell<T>, mapFn: (v: T) => any = id) {
    this.#cancel?.();
    this.#cancel = signal.sink(() => {
      if (this.isWatching) {
        this.setValue(mapFn(signal.getAsQueryResult()));
      }
    });
    return mapFn(signal.getAsQueryResult());
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
