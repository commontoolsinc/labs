import { z } from "zod";
import env from "@/env.ts";

export type UcanCap = { can: string; with: string; nb?: Record<string, unknown> };
export type UcanPayload = {
  iss: string;
  aud?: string;
  exp?: number;
  caps?: UcanCap[];
  att?: UcanCap[];
};

const JwtParts = z.tuple([z.string(), z.string(), z.string().or(z.literal(""))]);

function base64UrlDecode(input: string): Uint8Array {
  const pad = input.length % 4 === 2 ? "==" : input.length % 4 === 3 ? "=" : "";
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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

export function verifyJWT(token: string): VerifiedUcan {
  const parts = token.split(".");
  const parsed = JwtParts.safeParse(parts);
  if (!parsed.success) throw new Error("Invalid JWT format");
  const [h, p, s] = parsed.data;
  const header = jsonFromB64<Record<string, unknown>>(h);
  const payload = jsonFromB64<UcanPayload>(p);
  const signature = s ? base64UrlDecode(s) : new Uint8Array();

  if (payload.exp && Date.now() / 1000 > payload.exp) {
    throw new Error("Token expired");
  }

  const envIsDev = env.ENV === "development";
  if (!envIsDev) {
    const allowed = (Deno.env.get("UCAN_TRUSTED_ISSUERS") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowed.length > 0) {
      if (!payload.iss || !allowed.includes(payload.iss)) {
        throw new Error("Untrusted issuer");
      }
    }
  }

  return { header, payload, signature };
}

export type RequestCaps = Array<{ can: "storage/read" | "storage/write"; with: string }>;

export function hasCap(payload: UcanPayload, need: { can: string; with: string }): boolean {
  const caps = payload.caps ?? payload.att ?? [];
  return caps.some((c) => c.can === need.can && c.with === need.with);
}

export function parseAuthHeader(authHeader?: string): string | null {
  if (!authHeader) return null;
  const [scheme, token] = authHeader.split(" ", 2);
  if (!token || !/^Bearer$/i.test(scheme)) return null;
  return token.trim();
}

export function requireCaps(c: any, caps: RequestCaps) {
  const token = parseAuthHeader(c.req.header("authorization"));
  if (!token) return c.json({ error: { message: "Missing Authorization" } }, 401);
  try {
    const u = verifyJWT(token);
    const space = c.req.param()?.space as string | undefined;
    for (const need of caps) {
      const scopedWith = need.with && need.with.includes(":") ? need.with : `space:${space}`;
      if (!hasCap(u.payload, { can: need.can, with: scopedWith })) {
        return c.json({ error: { message: "Forbidden: missing capability" } }, 403);
      }
    }
    c.set && c.set("principal", u.payload.iss);
    return null;
  } catch (e) {
    return c.json({ error: { message: (e as Error).message } }, 401);
  }
}
