import type { AppRouteHandler } from "@/lib/types.ts";
import type { LoginRoute } from "./google-oauth.routes.ts";

export const login: AppRouteHandler<LoginRoute> = async (c) => {
  const logger = c.get("logger");
  const payload = await c.req.json();

  logger.info({ payload }, "Received Google OAuth login request");
  console.log("Google OAuth login payload:", payload);

  // For now, just return a mock URL
  // In a real implementation, this would generate a proper OAuth URL
  return c.json({
    url: `https://accounts.google.com/o/oauth2/auth?client_id=mock-client-id&redirect_uri=mock-redirect-uri/cellid&response_type=code&scope=email%20profile&state=${payload.authCellId}`,
  });
};
