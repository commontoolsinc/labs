import { SubscriberCommand, SubscriptionCommand, Query } from "./interface.ts";
import { Subscriber } from "./provider.ts";
import * as Socket from "./socket.ts";

export interface Subscriber extends TransformStream<SubscriptionCommand, SubscriberCommand> {}

/**
 * Takes a WebSocket and creates Subscriber.
 */
export const fromWebSocket = (socket: WebSocket): Subscriber => Socket.from(socket);

export const create = () => new SubscriberChannel();

class SubscriberChannel {
  controller: null | ReadableStreamDefaultController<SubscriberCommand>;
  readable: ReadableStream<SubscriberCommand>;
  writable: WritableStream<SubscriptionCommand>;
  commands: ReadableStream<SubscriptionCommand>;
  constructor() {
    this.controller = null;
    this.readable = new ReadableStream<SubscriberCommand>({
      start: (controller) => this.open(controller),
    });

    const { readable, writable } = new TransformStream<SubscriptionCommand, SubscriptionCommand>();
    this.writable = writable;

    this.commands = readable;
  }
  open(controller: ReadableStreamDefaultController<SubscriberCommand>) {
    this.controller = controller;
  }
  watch(source: Query) {
    this.controller?.enqueue({ watch: source });
  }
  unwatch(source: Query) {
    this.controller?.enqueue({ unwatch: source });
  }
  close() {
    this.controller?.close();
  }
}
