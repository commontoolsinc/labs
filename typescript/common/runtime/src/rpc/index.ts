import { RuntimeEvents, RuntimeRequests, RuntimeResponses } from './runtime.js';
import {
  HostModuleEvents,
  HostModuleRequests,
  HostModuleResponses,
  HostWorkerEvents,
  HostWorkerRequests,
  HostWorkerResponses,
} from './host.js';
import { ModuleEvents, ModuleRequests, ModuleResponses } from './module.js';
import { EventMap } from '../helpers.js';

export const HANDSHAKE_EVENT = 'rpc:handshake';

export type RPCEvent = {
  event: string;
  detail: any;
};

// NOTE: This asserts the top-level shape but not the substructure
export const isRPCEvent = (candidate: unknown): candidate is RPCEvent =>
  candidate != null &&
  typeof candidate == 'object' &&
  'event' in candidate &&
  typeof candidate.event == 'string';

export type RPCEventHandler<
  Events extends string,
  Requests extends EventMap<Events>,
  Responses extends EventMap<Events>
> = <
  E extends Events & keyof Requests & keyof Responses,
  Req extends Requests[E] = Requests[E],
  Res extends Responses[E] = Responses[E]
>(
  event: E,
  detail: Req
) => Promise<Res>;

export abstract class RPCClient<
  RxEvents extends string,
  RxRequests extends EventMap<RxEvents>,
  RxResponses extends EventMap<RxEvents>,
  TxEvents extends string,
  TxRequests extends EventMap<TxEvents>,
  TxResponses extends EventMap<TxEvents>
> {
  #port;

  #handler;

  constructor(
    port: MessagePort,
    handler: RPCEventHandler<RxEvents, RxRequests, RxResponses>
  ) {
    this.#port = port;
    this.#handler = handler;
    this.#port.addEventListener('message', this.#onPortMessage);
    this.#port.start();
  }

  async send<
    E extends TxEvents &
      keyof EventMap<TxRequests> &
      keyof EventMap<TxResponses>,
    D = TxRequests[E],
    R = TxResponses[E]
  >(event: E, detail: D, transfer: Transferable[] = []): Promise<R> {
    console.log(
      `[RPC] [sender] Sending ${event}:`,
      detail || '(empty request)'
    );
    const { port1: tx, port2: rx } = new MessageChannel();
    const response = new Promise<R>((resolve) => {
      const handler = (responseEvent: MessageEvent) => {
        rx.close();
        rx.removeEventListener('message', handler);

        console.log(
          `[RPC] [sender] Received ${event} response:`,
          responseEvent.data || '(empty response)'
        );

        resolve(responseEvent.data as R);
      };
      rx.addEventListener('message', handler);
      rx.start();
    });
    this.#port.postMessage(
      {
        event,
        detail,
        tx,
      },
      ([tx] as Transferable[]).concat(transfer)
    );
    return response;
  }

  #onPortMessage = async (event: MessageEvent) => {
    const {
      data,
      ports: [port, ..._],
    } = event;
    if (isRPCEvent(data)) {
      console.log(
        `[RPC] [receiver] Received ${data.event}:`,
        data.detail || '(empty request)'
      );
      const response = await this.#handler(data.event as any, data.detail);
      if (port) {
        console.log(
          `[RPC] [receiver] Sending ${data.event} response:`,
          response || '(empty response)'
        );
        port.postMessage(response);
      }
    }
  };
}

export class HostToRuntimeRPC extends RPCClient<
  HostWorkerEvents,
  HostWorkerRequests,
  HostWorkerResponses,
  RuntimeEvents,
  RuntimeRequests,
  RuntimeResponses
> {}

export class RuntimeToHostRPC extends RPCClient<
  RuntimeEvents,
  RuntimeRequests,
  RuntimeResponses,
  HostWorkerEvents,
  HostWorkerRequests,
  HostWorkerResponses
> {}

export class HostToModuleRPC extends RPCClient<
  HostModuleEvents,
  HostModuleRequests,
  HostModuleResponses,
  ModuleEvents,
  ModuleRequests,
  ModuleResponses
> {}

export class ModuleToHostRPC extends RPCClient<
  ModuleEvents,
  ModuleRequests,
  ModuleResponses,
  HostModuleEvents,
  HostModuleRequests,
  HostModuleResponses
> {}

export type NoEvents = '';
export type NoRequests = EventMap<NoEvents>;
export type NoResponses = EventMap<NoEvents>;

// @ts-ignore
export const NO_RPC_EVENT_HANDLER = (async () => {}) as RPCEventHandler<
  '',
  '',
  ''
>;
