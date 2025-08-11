import { Cancel, Cell } from "@commontools/runner";
import { assert } from "@std/assert";

export class CellUpdateEvent<T> extends CustomEvent<T> {
  constructor(value: T) {
    super("update", { detail: value });
  }
}

// Wraps a `Cell` as an `EventTarget`, firing `"update"`
// events when the cell's sink callback is fired.
export class CellEventTarget<T> extends EventTarget {
  #cell: Cell<T>;
  #cancel?: Cancel;
  #subscribers = 0;

  constructor(cell: Cell<T>) {
    super();
    this.#cell = cell;
  }

  #isEnabled(): boolean {
    return !!this.#cancel;
  }

  #enable() {
    assert(!this.#isEnabled());
    this.#cancel = this.#cell.sink((value) => {
      this.dispatchEvent(new CellUpdateEvent(value));
    });
  }

  #disable() {
    assert(this.#isEnabled());
    this.#cancel!();
    this.#cancel = undefined;
  }

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    if (type === "update") {
      this.#subscribers += 1;
      if (!this.#isEnabled()) {
        this.#enable();
      }
    }
    return super.addEventListener(type, callback, options);
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    if (type === "update") {
      this.#subscribers -= 1;
      if (this.#subscribers === 0) {
        this.#disable();
      }
    }
    return super.removeEventListener(type, callback, options);
  }
}
