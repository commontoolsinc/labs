/**
 * The guest side of the `common-iframe-sandbox` boundary.
 *
 * A guest runs in its own realm and reaches the host's key/value context over
 * a `MessagePort` the host hands it once its document has loaded. This module
 * is the client for that: it takes the port when it arrives, builds the
 * messages `./ipc.ts` describes, and hands the guest each value the host sends.
 *
 * The API is deliberately minimal -- it covers the operations the protocol
 * has, plus the teardown of its own listener.
 */

import {
  GUEST_PORT_HANDOFF,
  type GuestError,
  type GuestMessage,
  GuestMessageType,
  type HostMessage,
  HostMessageType,
} from "./ipc.ts";

/**
 * Called with each value the host sends: the answer to a {@link
 * GuestContext.read}, and each update on a subscribed key.
 */
export type UpdateHandler = (key: string, value: unknown) => void;

/**
 * A guest's handle on the host's key/value context.
 *
 * `read()` does not return the value. The host answers a read the same way it
 * announces a subscribed key's change, so both arrive at the handler given to
 * {@link connectGuestContext}.
 */
export type GuestContext = {
  /** Ask the host for `key`'s value, which arrives at the update handler. */
  read(key: string): void;

  /** Write `value` to `key`. */
  write(key: string, value: unknown): void;

  /**
   * Subscribe to each of `keys`. A change to one reaches the update handler;
   * the guest's own writes do not.
   */
  subscribe(...keys: string[]): void;

  /** Unsubscribe from each of `keys`. */
  unsubscribe(...keys: string[]): void;

  /** Stop listening for the host's messages. */
  disconnect(): void;
};

/**
 * Connects to the host, calling `onUpdate` with each value it sends.
 *
 * A guest may call the result's operations at once. The port arrives after the
 * document has loaded, and what is said before it does is sent when it comes,
 * in the order it was said.
 */
export function connectGuestContext(onUpdate: UpdateHandler): GuestContext {
  let port: MessagePort | undefined;
  const unsent: GuestMessage[] = [];

  const send = (message: GuestMessage): void => {
    if (port) {
      port.postMessage(message);
    } else {
      unsent.push(message);
    }
  };

  const onPortMessage = (event: MessageEvent): void => {
    const message = event.data as HostMessage | undefined;
    if (message?.type !== HostMessageType.Update) {
      return;
    }
    const [key, value] = message.data;
    onUpdate(key, value);
  };

  const onHandoff = (event: MessageEvent): void => {
    if (port || event.data !== GUEST_PORT_HANDOFF || !event.ports[0]) {
      return;
    }
    port = event.ports[0];
    port.onmessage = onPortMessage;
    port.start();
    for (const message of unsent) {
      port.postMessage(message);
    }
    unsent.length = 0;
  };

  globalThis.addEventListener("message", onHandoff);

  return {
    read(key: string): void {
      send({ type: GuestMessageType.Read, data: key });
    },

    write(key: string, value: unknown): void {
      send({ type: GuestMessageType.Write, data: [key, value] });
    },

    subscribe(...keys: string[]): void {
      send({ type: GuestMessageType.Subscribe, data: keys });
    },

    unsubscribe(...keys: string[]): void {
      send({ type: GuestMessageType.Unsubscribe, data: keys });
    },

    disconnect(): void {
      globalThis.removeEventListener("message", onHandoff);
      port?.close();
      port = undefined;
    },
  };
}

/**
 * Raises an alarm the host dispatches as a `common-iframe-error` event on the
 * element.
 *
 * This goes to the guest's parent rather than over the port, so it reaches the
 * host from a guest that has no working port -- a document whose scripts a
 * policy blocked, or one that failed before the handoff. It is the one thing
 * that route carries, and it is one-way: a guest cannot be answered on it.
 */
export function reportGuestError(error: GuestError): void {
  globalThis.parent.postMessage(
    { type: GuestMessageType.Error, data: error },
    "*",
  );
}
