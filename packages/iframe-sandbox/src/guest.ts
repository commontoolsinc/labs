/**
 * The guest side of the `common-iframe-sandbox` boundary.
 *
 * A guest runs in its own realm and reaches the host's key/value context by
 * `postMessage()`. This module is the client for that: it builds the messages
 * `./ipc.ts` describes, encodes and decodes the values in them, and hands the
 * guest a `FabricValue` for a `FabricValue` the host read.
 *
 * The API is deliberately minimal -- it covers the four operations the
 * protocol has and nothing beyond them.
 */

import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";

import {
  type GuestMessage,
  GuestMessageType,
  type HostMessage,
  HostMessageType,
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
};

/**
 * Connects to the host, calling `onUpdate` with each value it sends.
 */
export function connectGuestContext(onUpdate: UpdateHandler): GuestContext {
  const toHost = (message: GuestMessage): void => {
    globalThis.parent.postMessage(message, "*");
  };

  const onMessage = (event: MessageEvent): void => {
    const message = event.data as HostMessage | undefined;
    if (message?.type !== HostMessageType.Update) {
      return;
    }
    const [key, encoded] = message.data;
    onUpdate(key, fabricFromRealmValue(encoded));
  };

  globalThis.addEventListener("message", onMessage);

  return {
    read(key: string): void {
      toHost({ type: GuestMessageType.Read, data: key });
    },

    write(key: string, value: FabricValue): void {
      toHost({
        type: GuestMessageType.Write,
        data: [key, realmFromFabricValue(value)],
      });
    },

    subscribe(...keys: string[]): void {
      toHost({ type: GuestMessageType.Subscribe, data: keys });
    },

    unsubscribe(...keys: string[]): void {
      toHost({ type: GuestMessageType.Unsubscribe, data: keys });
    },
  };
}
