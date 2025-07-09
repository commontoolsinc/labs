import createApp from "@/lib/create-app.ts";
import health from "@/routes/health/health.index.ts";
import aiLLM from "@/routes/ai/llm/llm.index.ts";
import configureOpenAPI from "@/lib/configure-open-api.ts";
import aiImg from "@/routes/ai/img/img.index.ts";
import aiVoice from "@/routes/ai/voice/voice.index.ts";
import aiWebReader from "@/routes/ai/webreader/webreader.index.ts";
import aiSpell from "@/routes/ai/spell/spell.index.ts";
import discord from "@/routes/integrations/discord/discord.index.ts";
import googleOAuth from "@/routes/integrations/google-oauth/google-oauth.index.ts";
import plaidOAuth from "@/routes/integrations/plaid-oauth/plaid-oauth.index.ts";
import blobby from "@/routes/storage/blobby/blobby.index.ts";
import memory from "@/routes/storage/memory/memory.index.ts";
import frontendProxy from "@/routes/frontend/frontend.index.ts";
import spellbook from "@/routes/spellbook/spellbook.index.ts";
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
  aiSpell,
  discord,
  googleOAuth,
  plaidOAuth,
  blobby,
  memory,
  spellbook,
  whoami,
  meta,
  shell,
  staticRoute,
  frontendProxy, // This is the frontend proxy for jumble in the CDN.
] as const;

routes.forEach((route) => {
  app.route("/", route);
});

export type AppType = (typeof routes)[number];

export default app;
