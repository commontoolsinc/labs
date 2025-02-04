import { Hono } from "hono";
import { upgradeWebSocket } from "hono/deno";

const app = new Hono();
app.get(
  "/api/storage/memory",
  upgradeWebSocket((c) => {
    console.log("WS request");
    return {
      onMessage(event, ws) {
        console.log(`Message from client: ${event.data}`);
        ws.send("Hello from server!");
      },
      onClose: () => {
        console.log("Connection closed");
      },
    };
  }),
);

export default app;

// import { createRouter } from "@/lib/create-app.ts";
// import * as routes from "./memory.routes.ts";
// import * as handlers from "./memory.handlers.ts";
// // import { cors } from "hono/cors";

// // const router = createRouter();
// // router.use(cors());

// // const Router = router
// //   .openapi(routes.transact, handlers.transact)
// const app = new Hono().get(routes.subscribe.path, handlers.subscribe2);
// // .openapi(routes.subscribe, handlers.subscribe);

// // export default Router;
// export default app;
