/**
 * The guest side of the `common-iframe-sandbox` boundary.
 *
 * A guest runs in its own realm and reaches the host's key/value context by
 * `postMessage()`. This module is the client for that: it builds the messages
 * `./ipc.ts` describes, encodes and decodes the values in them, and hands the
 * guest a `FabricValue` for a `FabricValue` the host read.
 *
 * The API is deliberately minimal -- it covers the four operations the
 * protocol has, plus the teardown of its own listener.
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

  /** Stop listening for host messages. */
  disconnect(): void;
};

/**
 * Connects to the host, calling `onUpdate` with each value it sends.
 */
export function connectGuestContext(onUpdate: UpdateHandler): GuestContext {
  const toHost = (message: GuestMessage): void => {
    globalThis.parent.postMessage(message, "*");
  };

  // A guest window receives whatever anyone able to reach it posts, so an
  // arriving message is a claim rather than a fact. One that does not have an
  // update's shape, or whose value the decode refuses, is not this protocol's
  // and is left alone.
  const onMessage = (event: MessageEvent): void => {
    const message = event.data as HostMessage | undefined;
    if (
      message?.type !== HostMessageType.Update ||
      !Array.isArray(message.data) || message.data.length !== 2 ||
      typeof message.data[0] !== "string"
    ) {
      return;
    }

    const [key, encoded] = message.data;
    let value: FabricValue;
    try {
      value = fabricFromRealmValue(encoded);
    } catch {
      return;
    }
    onUpdate(key, value);
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

    disconnect(): void {
      globalThis.removeEventListener("message", onMessage);
    },
  };
}
