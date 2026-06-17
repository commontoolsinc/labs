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
  send(data: IPCClientMessage | IPCClientNotification): void;
  dispose(): Promise<void>;
}
