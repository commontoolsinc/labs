import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";

const tags = ["AI Voice TTS"];

export const SynthesizeRequestSchema = z.object({
  text: z.string().min(1).max(4096),
  voice: z.enum(["alloy", "echo", "fable", "onyx", "nova", "shimmer"])
    .default("nova"),
  model: z.enum(["tts-1", "tts-1-hd"]).default("tts-1"),
  speed: z.number().min(0.25).max(4.0).default(1.0),
});

export const SynthesizeResponseSchema = z.object({
  audioUrl: z.string().describe("URL to GET the audio from"),
  cacheKey: z.string(),
  timing: z.object({
    totalMs: z.number().describe("Time in ms to synthesize audio"),
    cached: z.boolean().describe("Whether the result was served from cache"),
  }),
});

export const ErrorResponseSchema = z.object({ error: z.string() });

// POST: submit text, get back a URL to the audio
export const synthesizeVoice = createRoute({
  path: "/api/ai/voice/synthesize",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": { schema: SynthesizeRequestSchema },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": { schema: SynthesizeResponseSchema },
      },
      description: "Audio URL for playback",
    },
    [HttpStatusCodes.BAD_REQUEST]: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid request",
    },
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Server error",
    },
  },
});

// GET: serve the audio file (streamed)
export const getAudio = createRoute({
  path: "/api/ai/voice/audio/:id",
  method: "get",
  tags,
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "audio/mpeg": {
          schema: z.any().describe("Streamed MP3 audio"),
        },
      },
      description: "Audio file",
    },
    [HttpStatusCodes.NOT_FOUND]: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Audio not found",
    },
  },
});

export type SynthesizeVoiceRoute = typeof synthesizeVoice;
export type GetAudioRoute = typeof getAudio;
