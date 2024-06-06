import { GuestEvents, GuestResponses } from './guest.js';
import { HostEvents, HostResponses } from './host.js';

export const HANDSHAKE_EVENT = 'ipc:handshake';

export type IPCEvent = {
  event: string;
  detail: any;
};

// NOTE: This asserts the top-level shape but not the substructure
export const isIPCEvent = (candidate: any): candidate is IPCEvent =>
  candidate != null &&
  typeof candidate.event == 'string' &&
  'detail' in candidate;

export type Handler<
  Events extends { [index: string]: unknown },
  Responses extends { [K in keyof Events]: unknown } = {
    [K in keyof Events]: unknown;
  }
> = <E extends keyof Events, D extends Events[E], R extends Responses[E]>(
  event: E,
  detail: D
) => Promise<R>;

export abstract class IPCClient<
  RxEvents extends {},
  RxResponses extends { [K in keyof RxEvents]: unknown },
  TxEvents extends {},
  TxResponses extends { [K in keyof TxEvents]: unknown }
> {
  #port;

  #handler;

  constructor(port: MessagePort, handler: Handler<RxEvents, RxResponses>) {
    this.#port = port;
    this.#handler = handler;
    this.#port.addEventListener('message', this.#onPortMessage);
    this.#port.start();
  }

  async send<E extends keyof TxEvents, D = TxEvents[E], R = TxResponses[E]>(
    event: E,
    detail: D
  ): Promise<R> {
    const { port1: tx, port2: rx } = new MessageChannel();
    const response = new Promise<R>((resolve) => {
      const handler = (event: MessageEvent) => {
        rx.close();
        rx.removeEventListener('message', handler);

        resolve(event.data as R);
      };
      rx.addEventListener('message', handler);
    });
    this.#port.postMessage(
      {
        event,
        detail,
      },
      [tx]
    );
    return response;
  }

  #onPortMessage = async (event: MessageEvent) => {
    const {
      data,
      ports: [port],
    } = event;
    if (isIPCEvent(data)) {
      const response = await this.#handler(
        data.event as keyof RxEvents,
        data.detail
      );
      if (port) {
        port.postMessage(response);
      }
    }
  };
}

export class IPCHost extends IPCClient<
  HostEvents,
  HostResponses,
  GuestEvents,
  GuestResponses
> {}

export class IPCGuest extends IPCClient<
  GuestEvents,
  GuestResponses,
  HostEvents,
  HostResponses
> {}
