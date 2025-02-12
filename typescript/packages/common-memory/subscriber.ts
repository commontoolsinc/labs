import { SubscriberCommand, SubscriptionCommand, Query } from "./interface.ts";
import { Subscriber } from "./provider.ts";

export interface Subscriber extends TransformStream<SubscriptionCommand, SubscriberCommand> {}

/**
 * Takes a WebSocket and creates Subscriber.
 */
export const fromWebSocket = (socket: WebSocket): Subscriber => ({
  readable: new ReadableStream({
    start(controller) {
      socket.onmessage = (event) => {
        try {
          controller.enqueue(JSON.parse(event.data) as SubscriberCommand);
        } catch (error) {
          controller.error(error);
        }
      };
      socket.onclose = () => {
        controller.close();
      };
      socket.onerror = (event) => {
        controller.error(event);
      };
    },
    cancel() {
      socket.close();
    },
  }),
  writable: new WritableStream({
    write(data: SubscriptionCommand) {
      socket.send(JSON.stringify(data));
    },
    close() {
      return socket.close();
    },
    abort() {
      return socket.close();
    },
  }),
});

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
