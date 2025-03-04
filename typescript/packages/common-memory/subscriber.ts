import {
  ConsumerSession,
  Protocol,
  Query,
  SubscriberCommand,
  SubscriptionCommand,
} from "./interface.ts";
import { Receipt, UCAN } from "./codec.ts";
import * as Socket from "./socket.ts";

/**
 * Takes a WebSocket and creates Subscriber.
 */
export const fromWebSocket = (socket: WebSocket): ConsumerSession<Protocol> => {
  const { readable, writable } = Socket.from<string, string>(socket);
  const receipt = Receipt.toStringStream();
  receipt.readable.pipeTo(writable);

  return {
    readable: readable.pipeThrough(UCAN.fromStringStream()) as ConsumerSession<
      Protocol
    >["readable"],
    writable: receipt.writable,
  };
};

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

    const { readable, writable } = new TransformStream<
      SubscriptionCommand,
      SubscriptionCommand
    >();
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
