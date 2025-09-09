import { GuestMessage, isGuestMessage } from "../types.ts";
import { QuickJSContext } from "../quick.ts";
import { bindConsole } from "./console.ts";

export class Bindings {
  #messages: GuestMessage[] = [];
  constructor(vm: QuickJSContext) {
    bindConsole(vm, this.#onGuestMessage);
  }

  drainMessages(): GuestMessage[] {
    const messages = [...this.#messages];
    this.#messages.length = 0;
    return messages;
  }

  #onGuestMessage = (message: unknown) => {
    if (!isGuestMessage(message)) {
      this.#messages.push({
        type: "error",
        error: `Received invalid message: ${message}`,
      });
      return;
    }
    this.#messages.push(message);
  };
}
