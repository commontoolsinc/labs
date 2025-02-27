import { fal } from "@fal-ai/client";
import type { AppRouteHandler } from "@/lib/types.ts";
import type {
  ErrorResponseSchema,
  SuccessResponseSchema,
  TranscribeVoiceRoute,
  TranscriptionChunk,
} from "./voice.routes.ts";
import env from "@/env.ts";
import { ensureDir } from "@std/fs";
import { crypto } from "@std/crypto";
import { z } from "zod";
import type { Logger } from "pino";

// Configure FAL client
fal.config({ credentials: env.FAL_API_KEY });

const CACHE_DIR = `${env.CACHE_DIR}/ai-voice`;
const ALLOWED_CONTENT_TYPES = ["audio/wav", "audio/mpeg"] as const;
type AllowedContentType = typeof ALLOWED_CONTENT_TYPES[number];

interface TranscriptionResult {
  transcription: string;
  chunks: TranscriptionChunk[];
}

// ElevenLabs API types
interface ElevenLabsTranscriptionResponse {
  text: string;
  words?: Array<{
    word: string;
    start: number;
    end: number;
    confidence: number;
  }>;
  iab_categories?: Record<string, number>;
  audio_events?: Array<{
    type: string;
    start: number;
    end: number;
  }>;
  speakers?: Array<{
    speaker_id: string;
    start: number;
    end: number;
  }>;
}

async function generateCacheKey(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function uploadToFAL(
  bytes: ArrayBuffer,
  contentType: AllowedContentType,
) {
  const file = new File([bytes], "audio.wav", { type: contentType });
  return await fal.storage.upload(file);
}

async function getCachedTranscription(
  cachePath: string,
  logger: Logger,
): Promise<TranscriptionResult | null> {
  try {
    const cachedResult = await Deno.readFile(cachePath);
    const result = JSON.parse(new TextDecoder().decode(cachedResult));
    logger.info(
      { path: cachePath },
      "🎯 Cache HIT - Serving cached transcription",
    );
    return result;
  } catch {
    return null;
  }
}

async function saveTranscriptionToCache(
  cachePath: string,
  data: TranscriptionResult,
  logger: Logger,
): Promise<void> {
  await ensureDir(CACHE_DIR);
  await Deno.writeFile(
    cachePath,
    new TextEncoder().encode(JSON.stringify(data)),
  );
  logger.info({ path: cachePath }, "Transcription cached");
}

function formatResponse(
  transcription: string,
  chunks: TranscriptionChunk[],
  responseType: "full" | "text" | "chunks",
): z.infer<typeof SuccessResponseSchema> {
  switch (responseType) {
    case "text":
      return { response_type: "text" as const, transcription };
    case "chunks":
      return { response_type: "chunks" as const, chunks };
    default:
      return { response_type: "full" as const, transcription, chunks };
  }
}

// Convert ElevenLabs word data to TranscriptionChunk format
function convertElevenLabsToChunks(
  response: ElevenLabsTranscriptionResponse,
): TranscriptionChunk[] {
  if (!response.words) {
    return [];
  }

  return response.words.map((word) => ({
    text: word.word,
    timestamp: [word.start, word.end],
    confidence: word.confidence,
  }));
}

export const transcribeVoice: AppRouteHandler<TranscribeVoiceRoute> = async (
  c,
) => {
  const logger = c.get("logger");
  const contentType = c.req.header("content-type") as AllowedContentType ||
    "audio/wav";

  if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
    logger.error({ contentType }, "Unsupported content type");
    return c.json({ error: "Unsupported content type" }, 400);
  }

  const audioBuffer = await c.req.arrayBuffer();
  if (audioBuffer.byteLength === 0) {
    logger.error("Empty audio buffer received");
    return c.json({ error: "No audio data provided" }, 400);
  }

  const responseType = (c.req.query("response_type") || "full") as
    | "full"
    | "text"
    | "chunks";

  const promptSha = await generateCacheKey(audioBuffer);
  const cachePath = `${CACHE_DIR}/${promptSha}.json`;

  logger.info(
    { bytes: audioBuffer.byteLength, promptSha, responseType },
    "Starting voice transcription",
  );

  // Check cache
  const cachedResult = await getCachedTranscription(cachePath, logger);
  if (cachedResult) {
    return c.json(
      formatResponse(
        cachedResult.transcription,
        cachedResult.chunks,
        responseType,
      ),
      200,
    );
  }

  logger.info({ promptSha }, "Cache MISS - Generating new transcription");

  // Get the provider from query params, default to "fal"
  const provider = c.req.query("provider") || "fal";

  try {
    let transcription: string;
    let chunks: TranscriptionChunk[];

    if (provider === "elevenlabs") {
      logger.info("Using ElevenLabs for transcription");
      const result = await transcribeWithElevenLabs(
        audioBuffer,
        contentType,
        logger,
      );
      transcription = result.transcription;
      chunks = result.chunks;
    } else {
      // Default to FAL
      logger.info("Using FAL for transcription");
      const audioUrl = await uploadToFAL(audioBuffer, contentType);
      logger.info({ audioUrl }, "Audio uploaded to FAL storage");

      const result = await fal.subscribe("fal-ai/wizper", {
        input: { audio_url: audioUrl },
      });

      if (!result.data?.text) {
        logger.error({ result }, "No transcription in response");
        return c.json({ error: "Failed to transcribe audio" }, 400);
      }

      transcription = result.data.text;
      chunks = result.data.chunks as unknown as TranscriptionChunk[] || [];
    }

    logger.info(
      { chars: transcription.length, chunks: chunks.length },
      "Transcription generated successfully",
    );

    const transcriptionResult = { transcription, chunks };
    await saveTranscriptionToCache(cachePath, transcriptionResult, logger);

    return c.json(
      formatResponse(transcription, chunks, responseType),
      200,
    );
  } catch (error) {
    logger.error({ error }, "Transcription failed");
    return c.json({ error: "Failed to transcribe audio" }, 500);
  }
};

async function transcribeWithElevenLabs(
  audioBuffer: ArrayBuffer,
  contentType: AllowedContentType,
  logger: Logger,
): Promise<TranscriptionResult> {
  if (!env.ELEVENLABS_API_KEY) {
    throw new Error("ELEVENLABS_API_KEY is not configured");
  }

  const url = "https://api.elevenlabs.io/v1/speech-to-text";

  // Create form data with the audio file
  const formData = new FormData();
  const file = new File([audioBuffer], "audio.wav", { type: contentType });
  formData.append("file", file);
  formData.append("model_id", "scribe_v1");
  formData.append("tag_audio_events", "true");
  formData.append("diarize", "true");

  // Optional: detect language automatically by not specifying language_code
  // formData.append("language_code", "eng");

  logger.info("Sending request to ElevenLabs API");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": env.ELEVENLABS_API_KEY,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      "ElevenLabs API error",
    );
    throw new Error(`ElevenLabs API error: ${response.status} ${errorText}`);
  }

  const data = await response.json() as ElevenLabsTranscriptionResponse;

  if (!data.text) {
    throw new Error("No transcription returned from ElevenLabs");
  }

  logger.info({
    textLength: data.text.length,
    hasWords: !!data.words,
    wordCount: data.words?.length || 0,
  }, "ElevenLabs transcription received");

  return {
    transcription: data.text,
    chunks: convertElevenLabsToChunks(data),
  };
}
