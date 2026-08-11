import { EventEmitter } from "./emitter.ts";
import {
  IPCClientMessage,
  IPCClientNotification,
  IPCRemoteMessage,
} from "../protocol/mod.ts";

export type RuntimeTransportEvents = {
  message: [IPCRemoteMessage];
};

export interface RuntimeTransport extends EventEmitter<RuntimeTransportEvents> {
  /**
   * Delivers a message to the far end, which must receive it as a value it
   * owns outright -- unshared with the sender, and not becoming shared
   * afterwards. `BaseRequest` states what a handler is then entitled to assume.
   *
   * Structured cloning satisfies this, so a `postMessage` transport gets it for
   * nothing. A transport that would instead hand the same object to both ends
   * does not, and cannot be used as-is.
   */
  send(data: IPCClientMessage | IPCClientNotification): void;
  dispose(): Promise<void>;
}
