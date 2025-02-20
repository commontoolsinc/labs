/**
 * Takes a WebSocket and turns it into a transform stream.
 */
export const from = <In, Out>(socket: WebSocket): TransformStream<Out, In> => {
  let ready = false;
  const open = opened(socket);

  return {
    readable: new ReadableStream({
      start(controller) {
        socket.onmessage = (event) => {
          try {
            const input = JSON.parse(event.data) as In;
            controller.enqueue(input);
          } catch (error) {
            controller.error(error);
          }
        };
        socket.onclose = () => {
          controller.close();
        };
        socket.onerror = (event) => {
          socket.onclose = null;
          controller.error(event);
        };
      },
      cancel() {
        socket.close();
      },
    }),
    writable: new WritableStream({
      async write(data: Out) {
        if (!ready) {
          await open;
          ready = true;
        }

        socket.send(JSON.stringify(data));
      },
      close() {
        socket.onclose = null;
        return socket.close();
      },
      abort() {
        return socket.close();
      },
    }),
  };
};

export const opened = async (socket: WebSocket) => {
  if (socket.readyState === WebSocket.CONNECTING) {
    await new Promise((resolve) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", resolve, { once: true });
    });
  }

  switch (socket.readyState) {
    case WebSocket.OPEN:
      return socket;
    case WebSocket.CLOSING:
      throw new Error(`Socket is closing`);
    case WebSocket.CLOSED:
      throw new Error(`Socket is closed`);
    default:
      throw new Error(`Socket is in unknown state`);
  }
};
