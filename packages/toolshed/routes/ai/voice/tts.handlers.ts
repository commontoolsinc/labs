import type { AppRouteHandler } from "@/lib/types.ts";
import type { GetAudioRoute, SynthesizeVoiceRoute } from "./tts.routes.ts";
import env from "@/env.ts";
import { ensureDir } from "@std/fs";
import { crypto } from "@std/crypto";

const CACHE_DIR = `${env.CACHE_DIR}/ai-tts`;

async function generateCacheKey(
  text: string,
  voice: string,
  model: string,
  speed: number,
): Promise<string> {
  const input = JSON.stringify({ text, voice, model, speed });
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const synthesizeVoice: AppRouteHandler<SynthesizeVoiceRoute> = async (
  c,
) => {
  const logger = c.get("logger");
  const { text, voice, model, speed } = c.req.valid("json");

  try {
    const cacheKey = await generateCacheKey(text, voice, model, speed);
    const cachePath = `${CACHE_DIR}/${cacheKey}.mp3`;
    const audioUrl = `/api/ai/voice/audio/${cacheKey}`;

    // If already cached, return URL immediately
    try {
      await Deno.stat(cachePath);
      logger.info({ cacheKey }, "TTS cache HIT");
      return c.json({
        audioUrl,
        cacheKey,
        timing: { totalMs: 0, cached: true },
      });
    } catch { /* cache miss */ }

    logger.info(
      { text: text.slice(0, 100), voice, model },
      "TTS cache MISS — calling OpenAI",
    );

    const ttsStart = Date.now();

    // Call OpenAI TTS — streams audio back
    const response = await fetch(
      "https://api.openai.com/v1/audio/speech",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.CTTS_AI_LLM_OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: text,
          voice,
          speed,
          response_format: "mp3",
        }),
      },
    );

    if (!response.ok) {
      const err = await response.text();
      logger.error({ status: response.status, err }, "OpenAI TTS failed");
      return c.json({ error: "TTS synthesis failed" }, 500);
    }

    // Save audio to cache
    await ensureDir(CACHE_DIR);
    const audioBytes = new Uint8Array(await response.arrayBuffer());
    await Deno.writeFile(cachePath, audioBytes);

    const ttsDurationMs = Date.now() - ttsStart;
    logger.info({
      cacheKey,
      bytes: audioBytes.byteLength,
      ttsDurationMs,
    }, "TTS audio cached");

    return c.json({
      audioUrl,
      cacheKey,
      timing: { totalMs: ttsDurationMs, cached: false },
    });
  } catch (error) {
    logger.error({ error }, "TTS synthesis failed");
    return c.json({ error: "TTS synthesis failed" }, 500);
  }
};

export const getAudio: AppRouteHandler<GetAudioRoute> = async (c) => {
  const logger = c.get("logger");
  const { id } = c.req.param();

  // Validate ID is a hex SHA-256 hash to prevent path traversal
  if (!/^[a-f0-9]{64}$/.test(id)) {
    return c.json({ error: "Invalid audio ID" }, 404);
  }

  const cachePath = `${CACHE_DIR}/${id}.mp3`;

  try {
    const file = await Deno.open(cachePath, { read: true });
    const stat = await file.stat();

    return new Response(file.readable, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(stat.size),
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch {
    logger.warn({ id }, "Audio file not found");
    return c.json({ error: "Audio not found" }, 404);
  }
};
