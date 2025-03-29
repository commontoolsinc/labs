import { traceAsync, traceSync } from "./telemetry.ts";

/**
 * Takes a WebSocket and turns it into a transform stream.
 */
export const from = <
  In extends string | Uint8Array | Blob,
  Out extends string | Uint8Array | Blob,
>(
  socket: WebSocket,
): TransformStream<Out, In> => {
  return traceSync("socket.create", (span) => {
    let ready = false;
    const open = opened(socket);
    let messageCount = 0;

    span.setAttribute("socket.state", socket.readyState);

    const result: TransformStream<Out, In> = {
      readable: new ReadableStream({
        start(controller) {
          socket.onmessage = (event) => {
            try {
              messageCount++;
              span.setAttribute("socket.message_count", messageCount);
              controller.enqueue(event.data);
            } catch (error) {
              controller.error(error);
            }
          };
          socket.onclose = () => {
            try {
              span.setAttribute("socket.final_state", "closed");
              controller.close();
            } catch (error) {
              controller.error(error);
            }
          };
          socket.onerror = (event) => {
            span.setAttribute("socket.error", true);
            socket.onclose = null;
            controller.error(event);
          };
        },
        cancel(reason?) {
          console.log("Socket canceled", reason);
          span.setAttribute("socket.cancelled", true);
          socket.close();
        },
      }),
      writable: new WritableStream({
        async write(data: Out) {
          if (!ready) {
            await open;
            ready = true;
            span.setAttribute("socket.ready", true);
          }

          socket.send(data);
        },
        close() {
          socket.onclose = null;
          return socket.close();
        },
        abort() {
          span.setAttribute("socket.aborted", true);
          return socket.close();
        },
      }),
    };

    return result;
  });
};

export const opened = async (socket: WebSocket) => {
  return await traceAsync("socket.open", async (span) => {
    span.setAttribute("socket.state", socket.readyState);

    if (socket.readyState === WebSocket.CONNECTING) {
      await new Promise((resolve) => {
        socket.addEventListener("open", () => {
          span.setAttribute("socket.open_event", true);
          resolve(null);
        }, { once: true });

        socket.addEventListener("error", () => {
          span.setAttribute("socket.error_event", true);
          resolve(null);
        }, { once: true });
      });
    }

    switch (socket.readyState) {
      case WebSocket.OPEN:
        span.setAttribute("socket.final_state", "open");
        return socket;
      case WebSocket.CLOSING:
        span.setAttribute("socket.final_state", "closing");
        throw new Error(`Socket is closing`);
      case WebSocket.CLOSED:
        span.setAttribute("socket.final_state", "closed");
        throw new Error(`Socket is closed`);
      default:
        span.setAttribute("socket.final_state", "unknown");
        throw new Error(`Socket is in unknown state`);
    }
  });
};
