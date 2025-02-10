import createApp from "@/lib/create-app.ts";
import health from "@/routes/health/health.index.ts";
import aiLLM from "@/routes/ai/llm/llm.index.ts";
import configureOpenAPI from "@/lib/configure-open-api.ts";
import aiImg from "@/routes/ai/img/img.index.ts";
import aiVoice from "@/routes/ai/voice/voice.index.ts";
import aiWebReader from "@/routes/ai/webreader/webreader.index.ts";
import aiSpell from "@/routes/ai/spell/spell.index.ts";
import discord from "@/routes/integrations/discord/discord.index.ts";
import blobby from "@/routes/storage/blobby/blobby.index.ts";
import memory from "@/routes/storage/memory/memory.index.ts";
import lookslikeHighlevelApp from "@/routes/frontend-proxy/lookslike-highlevel-app.index.ts";
import frontendProxy from "@/routes/frontend-proxy/frontend-proxy.index.ts";

const app = createApp();

configureOpenAPI(app);

const routes = [
  health,
  aiLLM,
  aiImg,
  aiVoice,
  aiWebReader,
  aiSpell,
  discord,
  blobby,
  memory,
  lookslikeHighlevelApp, // This is a frontend proxy for lookslike-highlevel in the CDN.
  frontendProxy, // This is the frontend proxy for jumble in the CDN.
] as const;

routes.forEach((route) => {
  app.route("/", route);
});

export type AppType = (typeof routes)[number];

export default app;
