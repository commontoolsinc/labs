import { Hono } from "hono";
import { cors } from "hono/cors";
import * as fal from "@fal-ai/serverless-client";

type Bindings = {
	FAL_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use(
	"*",
	cors({
		origin: (origin: string, _) => {
			if (origin.startsWith("http://localhost:")) return origin;
			if (origin.includes("saga-castor.ts.net")) return origin;
			return "https://common.tools";
		},
	}),
);

async function uploadToFAL({ env, bytes, type = "audio/wav" }: { env: Bindings; bytes: ArrayBuffer; type?: string }) {
	fal.config({
		credentials: env.FAL_KEY,
	});

	const file = new File([bytes], "audio.wav", { type });
	return await fal.storage.upload(file);
}

async function transcribe({ env, url }: { env: Bindings; url: string }) {
	fal.config({
		credentials: env.FAL_KEY,
	});
	return fal.subscribe("fal-ai/wizper", {
		input: {
			audio_url: url,
		},
	}).then((response: any) => response.text);
}

app.post("/api/transcribe", async (c) => {
	const audioBuffer = await c.req.arrayBuffer();
	const url = await uploadToFAL({ env: c.env, bytes: audioBuffer });
	const transcription = await transcribe({ env: c.env, url });
	return c.json({ transcription });
});

export default app;
