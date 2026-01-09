import { EventEmitter } from "./emitter.ts";
import { IPCClientMessage, IPCRemoteMessage } from "../protocol/mod.ts";

export type RuntimeTransportEvents = {
  message: [IPCRemoteMessage];
};

export interface RuntimeTransport extends EventEmitter<RuntimeTransportEvents> {
  send(data: IPCClientMessage): void;
  dispose(): Promise<void>;
}
