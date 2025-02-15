/**
 * Takes a WebSocket and turns it into a transform stream.
 */
export const from = <In, Out>(socket: WebSocket): TransformStream<Out, In> => ({
  readable: new ReadableStream({
    start(controller) {
      socket.onmessage = (event) => {
        try {
          controller.enqueue(JSON.parse(event.data) as In);
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
    write(data: Out) {
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
