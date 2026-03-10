import createApp from "@/lib/create-app.ts";
import health from "@/routes/health/health.index.ts";
import aiLLM from "@/routes/ai/llm/llm.index.ts";
import configureOpenAPI from "@/lib/configure-open-api.ts";
import aiImg from "@/routes/ai/img/img.index.ts";
import aiVoice from "@/routes/ai/voice/voice.index.ts";
import aiWebReader from "@/routes/ai/webreader/webreader.index.ts";
import linkPreview from "@/routes/link-preview/link-preview.index.ts";
import agentToolsWebSearch from "@/routes/agent-tools/web-search/web-search.index.ts";
import agentToolsWebRead from "@/routes/agent-tools/web-read/web-read.index.ts";
import discord from "@/routes/integrations/discord/discord.index.ts";
import plaidOAuth from "@/routes/integrations/plaid-oauth/plaid-oauth.index.ts";
import { buildProviderRouters } from "@/routes/integrations/provider-registry.ts";
import memory from "@/routes/storage/memory/memory.index.ts";
import whoami from "@/routes/whoami/whoami.index.ts";
import meta from "@/routes/meta/meta.index.ts";
import shell from "@/routes/shell/shell.index.ts";
import staticRoute from "@/routes/static/static.index.ts";
import patterns from "@/routes/patterns/patterns.index.ts";
import sandboxExec from "@/routes/sandbox/exec/exec.index.ts";
import webhooks from "@/routes/webhooks/webhooks.index.ts";

const app = createApp();

configureOpenAPI(app);

// Static routes (non-OAuth2, plus non-standard OAuth like Discord and Plaid)
const routes = [
  health,
  aiLLM,
  aiImg,
  aiVoice,
  aiWebReader,
  linkPreview,
  agentToolsWebSearch,
  agentToolsWebRead,
  discord,
  plaidOAuth,
  memory,
  whoami,
  meta,
  staticRoute,
  patterns,
  sandboxExec,
  webhooks,
] as const;

routes.forEach((route) => {
  app.route("/", route);
});

// Dynamic OAuth2 provider routes (Google, Airtable, etc.)
const providerRouters = await buildProviderRouters();
providerRouters.forEach((router) => app.route("/", router));

// Shell serves at root, so add it last to catch all unmatched routes
app.route("/", shell);

export type AppType = (typeof routes)[number];

export default app;
