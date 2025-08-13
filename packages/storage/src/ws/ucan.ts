// Minimal UCAN JWT parsing and capability checks for WS v2

export type UcanCap = {
  can: string;
  with: string;
  nb?: Record<string, unknown>;
};
export type UcanPayload = {
  iss: string;
  aud?: string;
  exp?: number;
  caps?: UcanCap[];
  att?: UcanCap[];
};

import { decodeBase64Url } from "../codec/bytes.ts";
function base64UrlDecode(input: string): Uint8Array {
  return decodeBase64Url(input);
}

function jsonFromB64<T>(b64u: string): T {
  const bytes = base64UrlDecode(b64u);
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as T;
}

export type VerifiedUcan = {
  header: Record<string, unknown>;
  payload: UcanPayload;
  signature: Uint8Array;
};

export function parseAuthHeader(authHeader?: string): string | null {
  if (!authHeader) return null;
  const [scheme, token] = authHeader.split(" ", 2);
  if (!token || !/^Bearer$/i.test(scheme)) return null;
  return token.trim();
}

export function verifyJWT(token: string): VerifiedUcan {
  const parts = token.split(".");
  if (parts.length < 2) throw new Error("Invalid JWT format");
  const [h, p, s] = parts as [string, string, string];
  const header = jsonFromB64<Record<string, unknown>>(h);
  const payload = jsonFromB64<UcanPayload>(p);
  const signature = s ? base64UrlDecode(s) : new Uint8Array();

  if (payload.exp && Date.now() / 1000 > payload.exp) {
    throw new Error("Token expired");
  }

  // Production signature verification can be added later (out of scope here)
  return { header, payload, signature };
}

export function hasCap(
  payload: UcanPayload,
  need: { can: string; with: string },
): boolean {
  const caps = payload.caps ?? payload.att ?? [];
  return caps.some((c) => c.can === need.can && c.with === need.with);
}

export function requireCapsOnRequest(
  req: Request,
  caps: Array<{ can: string; with: string }>,
): Response | null {
  const token = parseAuthHeader(req.headers.get("authorization") ?? undefined);
  if (!token) {
    return new Response(
      JSON.stringify({ error: { message: "Missing Authorization" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }
  try {
    const u = verifyJWT(token);
    for (const need of caps) {
      if (!hasCap(u.payload, need)) {
        return new Response(
          JSON.stringify({
            error: { message: "Forbidden: missing capability" },
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }
    }
    return null;
  } catch (e) {
    return new Response(
      JSON.stringify({ error: { message: (e as Error).message } }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }
}
