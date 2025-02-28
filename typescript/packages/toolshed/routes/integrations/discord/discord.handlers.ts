import env from "@/env.ts";
import { Context } from "@hono/hono";
import type { SendMessageRoute } from "@/routes/integrations/discord/discord.routes.ts";
import type { AppRouteHandler } from "@/lib/types.ts";

type WebhookMessage = {
  content: string;
  username?: string;
  avatar_url?: string;
  embeds?: Array<{
    title?: string;
    description?: string;
    color?: number;
    fields?: Array<{
      name: string;
      value: string;
      inline?: boolean;
    }>;
  }>;
};

export const sendMessage: AppRouteHandler<SendMessageRoute> = async (
  ctx: Context,
) => {
  const body = await ctx.req.json();

  try {
    const response = await sendWebhookMessage({
      content: body.message,
      username: body.username,
    });
    const responseBody = await response.json();
    return ctx.json(responseBody, 200);
  } catch (error) {
    console.error(error);
    return ctx.json({ error: "Failed to send message" }, 500);
  }
};

export const sendWebhookMessage = async (message: WebhookMessage) => {
  const webhookUrl = env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("DISCORD_WEBHOOK_URL not configured");
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    const responseText = await response.text();
    console.error("Webhook request failed:", {
      status: response.status,
      statusText: response.statusText,
      body: message,
      response: responseText,
    });
    throw new Error(`Failed to send webhook message: ${response.statusText}`);
  }

  return response;
};
