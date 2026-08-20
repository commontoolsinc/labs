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
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";

import {
  GUEST_PORT_HANDOFF,
  type GuestError,
  type GuestMessage,
  GuestMessageType,
  isHostMessage,
} from "./ipc.ts";

/**
 * Called with each value the host sends: the answer to a {@link
 * GuestContext.read}, and each update on a subscribed key.
 */
export type UpdateHandler = (key: string, value: FabricValue) => void;

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
  write(key: string, value: FabricValue): void;

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
      port.postMessage(realmFromFabricValue(message));
    } else {
      unsent.push(message);
    }
  };

  // The port's far end is the host, so what arrives on it is not the open
  // question a window message is. It is still checked before being taken
  // apart: what does not decode, and what decodes to something this protocol
  // does not write, are both left alone rather than guessed at.
  const onPortMessage = (event: MessageEvent): void => {
    let decoded: FabricValue;
    try {
      decoded = fabricFromRealmValue(event.data);
    } catch {
      return;
    }
    if (!isHostMessage(decoded)) {
      return;
    }
    const [key, value] = decoded.data;
    onUpdate(key, value);
  };

  // A guest window receives whatever anyone able to reach it posts, so the
  // handoff is recognized by what it says and taken only once. A second one
  // would replace a live port with one the host is not listening on.
  const onHandoff = (event: MessageEvent): void => {
    if (port || event.data !== GUEST_PORT_HANDOFF || !event.ports[0]) {
      return;
    }
    port = event.ports[0];
    port.onmessage = onPortMessage;
    port.start();
    for (const message of unsent) {
      port.postMessage(realmFromFabricValue(message));
    }
    unsent.length = 0;
  };

  globalThis.addEventListener("message", onHandoff);

  return {
    read(key: string): void {
      send({ type: GuestMessageType.Read, data: key });
    },

    write(key: string, value: FabricValue): void {
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
