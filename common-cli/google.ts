import { open } from "open";
import { OAuth2Client } from "@cmd-johnson/oauth2-client";

export async function getAccessToken(client: OAuth2Client) {
  let authCode: string | null = null;
  const controller = new AbortController();
  const server = Deno.serve(
    { port: 8080, signal: controller.signal },
    (req) => {
      const url = new URL(req.url);
      if (url.searchParams.has("code")) {
        authCode = url.searchParams.get("code");
        controller.abort();
        return new Response(
          "Authentication successful! You can close this window.",
        );
      }
      return new Response("Waiting for authentication...");
    },
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

  const tokens = await client.code.getToken(
    new URL(`http://localhost:8080?code=${authCode}`),
    {
      codeVerifier,
    },
  );

  return tokens.accessToken;
}
