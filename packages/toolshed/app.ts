import createApp from "@/lib/create-app.ts";
import health from "@/routes/health/health.index.ts";
import aiLLM from "@/routes/ai/llm/llm.index.ts";
import configureOpenAPI from "@/lib/configure-open-api.ts";
import aiImg from "@/routes/ai/img/img.index.ts";
import aiVoice from "@/routes/ai/voice/voice.index.ts";
import aiWebReader from "@/routes/ai/webreader/webreader.index.ts";
import discord from "@/routes/integrations/discord/discord.index.ts";
import googleOAuth from "@/routes/integrations/google-oauth/google-oauth.index.ts";
import plaidOAuth from "@/routes/integrations/plaid-oauth/plaid-oauth.index.ts";
import memory from "@/routes/storage/memory/memory.index.ts";
import whoami from "@/routes/whoami/whoami.index.ts";
import meta from "@/routes/meta/meta.index.ts";
import shell from "@/routes/shell/shell.index.ts";
import staticRoute from "@/routes/static/static.index.ts";

const app = createApp();

configureOpenAPI(app);

const routes = [
  health,
  aiLLM,
  aiImg,
  aiVoice,
  aiWebReader,
  discord,
  googleOAuth,
  plaidOAuth,
  memory,
  whoami,
  meta,
  staticRoute,
] as const;

routes.forEach((route) => {
  app.route("/", route);
});

// Shell serves at root, so add it last to catch all unmatched routes
app.route("/", shell);

export type AppType = (typeof routes)[number];

export default app;
