import { serve } from "https://deno.land/std@0.216.0/http/server.ts";
import { open } from "https://deno.land/x/open@v0.0.6/index.ts";
import { OAuth2Client } from "jsr:@cmd-johnson/oauth2-client@^2.0.0";

export async function getAccessToken(client: OAuth2Client) {
  let authCode: string | null = null;
  const controller = new AbortController();
  const server = serve(
    (req) => {
      const url = new URL(req.url);
      if (url.searchParams.has("code")) {
        authCode = url.searchParams.get("code");
        controller.abort();
        return new Response("Authentication successful! You can close this window.");
      }
      return new Response("Waiting for authentication...");
    },
    { port: 8080, signal: controller.signal },
  );

  const { uri, codeVerifier } = await client.code.getAuthorizationUri();
  console.log("Opening browser for authentication...");
  await open(uri.toString());

  try {
    await server;
  } catch (err: any) {
    if (err.name !== "AbortError") throw err;
  }

  if (!authCode) {
    throw new Error("Failed to get authorization code");
  }

  const tokens = await client.code.getToken(new URL(`http://localhost:8080?code=${authCode}`), {
    codeVerifier,
  });

  return tokens.accessToken;
}
