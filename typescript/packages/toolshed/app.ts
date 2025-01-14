import createApp from "@/lib/create-app.ts";
import health from "@/routes/health/health.index.ts";
import aiLLM from "@/routes/ai/llm/llm.index.ts";
import configureOpenAPI from "@/lib/configure-open-api.ts";

const app = createApp();

configureOpenAPI(app);

const routes = [
  health,
  aiLLM,
] as const;

routes.forEach((route) => {
  app.route("/", route);
});

export type AppType = typeof routes[number];

export default app;
