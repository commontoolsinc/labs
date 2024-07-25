import { directive } from "lit/directive.js";
import { AsyncDirective } from "lit/async-directive.js";
import { effect, ReactiveEffectRunner, Ref, ref, stop } from "@vue/reactivity";

class ReactiveWatchDirective extends AsyncDirective {
  #runner: ReactiveEffectRunner | undefined = undefined;
  #isWatching = true;

  override render(state: any | Ref<any>, key: any | undefined = undefined) {
    if (this.#runner) {
      stop(this.#runner);
    }

    this.#runner = effect(() => {
      if (this.#isWatching) {
        if (key !== undefined) {
          this.setValue(state[key]);
        } else {
          this.setValue(state.value);
        }
      }
    });

    if (key !== undefined) {
      return state[key];
    } else {
      return state.value;
    }
  }

  protected override disconnected(): void {
    this.#isWatching = false;
  }

  protected override reconnected(): void {
    this.#isWatching = true;
  }
}

type Watch =
  | (<T>(state: T | Ref<T>, key: keyof T) => any)
  | (<T>(state: T | Ref<T>) => any);

/**
 * Renders a signal and subscribes to it, updating the part when the signal
 * changes.
 */
export const watch: Watch = directive(ReactiveWatchDirective);
