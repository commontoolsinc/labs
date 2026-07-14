import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  buildCompositionPlan,
  buildFfconcat,
  FrameRecorder,
  parsePresentationConfig,
  type RecordedFrame,
} from "../presentation/mod.ts";
import type { Page_screencastFrame } from "../../vendor-astral/bindings/celestial.ts";

Deno.test("parsePresentationConfig stays disabled without an output directory", () => {
  assertEquals(parsePresentationConfig({}), { enabled: false });
});

Deno.test("parsePresentationConfig supplies deterministic defaults", () => {
  const config = parsePresentationConfig({
    CF_DEMO_OUTPUT_DIR: "/tmp/demo",
  });
  assertEquals(config.enabled, true);
  if (!config.enabled) throw new Error("expected enabled config");
  assertEquals(config.outputDir, "/tmp/demo");
  assertEquals(config.videoFileName, "demo.mp4");
  assertEquals(config.viewport, { width: 1280, height: 720 });
  assertEquals(config.typingDelayMs, 55);
  assertEquals(config.cursorTravelMs, 350);
  assertEquals(config.postResultHoldMs, 800);
  assertEquals(config.jpegQuality, 85);
});

Deno.test("parsePresentationConfig names and validates the output video", () => {
  const config = parsePresentationConfig({
    CF_DEMO_OUTPUT_DIR: "/tmp/demo",
    CF_DEMO_NAME: "lunch-poll-vote",
  });
  if (!config.enabled) throw new Error("expected enabled config");
  assertEquals(config.videoFileName, "lunch-poll-vote.mp4");
  assertThrows(
    () =>
      parsePresentationConfig({
        CF_DEMO_OUTPUT_DIR: "/tmp/demo",
        CF_DEMO_NAME: "../escape",
      }),
    Error,
    "safe filename stem",
  );
});

Deno.test("parsePresentationConfig validates numeric overrides", () => {
  assertThrows(
    () =>
      parsePresentationConfig({
        CF_DEMO_OUTPUT_DIR: "/tmp/demo",
        CF_DEMO_VIEWPORT: "wide",
      }),
    Error,
    "CF_DEMO_VIEWPORT",
  );
});

Deno.test("buildFfconcat preserves variable durations and repeats final frame", () => {
  const frames: RecordedFrame[] = [
    frame("frames/000001.jpg", 0, 0.4),
    frame("frames/000002.jpg", 400, 1.1),
    frame("frames/000003.jpg", 1500, 0.8),
  ];
  assertEquals(
    buildFfconcat(frames),
    [
      "ffconcat version 1.0",
      "file 'frames/000001.jpg'",
      "duration 0.400000",
      "file 'frames/000002.jpg'",
      "duration 1.100000",
      "file 'frames/000003.jpg'",
      "duration 0.800000",
      "file 'frames/000003.jpg'",
      "",
    ].join("\n"),
  );
});

Deno.test("buildFfconcat rejects an empty recording", () => {
  assertThrows(
    () => buildFfconcat([]),
    Error,
    "no frames",
  );
});

Deno.test("buildCompositionPlan creates deterministic one through four participant layouts", () => {
  assertEquals(buildCompositionPlan(["alice"]), {
    width: 1280,
    height: 720,
    filter:
      "[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black[vout]",
    outputLabel: "vout",
  });

  const two = buildCompositionPlan(["alice", "bob"]);
  assertEquals({ width: two.width, height: two.height }, {
    width: 2560,
    height: 720,
  });
  assertStringIncludes(two.filter, "hstack=inputs=2:shortest=1[vout]");

  const three = buildCompositionPlan(["alice", "bob", "carol"]);
  assertEquals({ width: three.width, height: three.height }, {
    width: 2560,
    height: 1440,
  });
  assertStringIncludes(three.filter, "xstack=inputs=4");
  assertStringIncludes(three.filter, "color=c=black:s=1280x720");
  assertStringIncludes(three.filter, "shortest=1[vout]");

  const four = buildCompositionPlan(["a", "b", "c", "d"]);
  assertStringIncludes(four.filter, "layout=0_0|1280_0|0_720|1280_720");
});

Deno.test("buildCompositionPlan rejects more than four participants", () => {
  assertThrows(
    () => buildCompositionPlan(["a", "b", "c", "d", "e"]),
    Error,
    "at most four",
  );
});

Deno.test("FrameRecorder acknowledges immediately and preserves variable timing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let now = 100;
    const page = new FakeScreencastPage();
    const writes: string[] = [];
    const recorder = new FrameRecorder(page, {
      participantDir: dir,
      id: "alice",
      label: "Alice",
      color: "#7c3aed",
      quality: 85,
      viewport: { width: 1280, height: 720 },
      finalHoldMs: 800,
      clock: { now: () => now },
      writeFile: async (path) => {
        await Promise.resolve();
        writes.push(path);
      },
    });
    await recorder.start();
    page.emit(screencastFrame(1));
    assertEquals(page.acknowledged, [1]);
    now = 600;
    page.emit(screencastFrame(2));
    now = 700;
    const manifest = await recorder.stop();
    assertEquals(writes.length, 2);
    assertEquals(manifest.frames.map((item) => item.durationSeconds), [
      0.5,
      0.8,
    ]);
    assertEquals(manifest.captureStartedAtMs, 100);
    assertEquals(manifest.captureEndedAtMs, 700);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

function frame(
  path: string,
  recordedAtMs: number,
  durationSeconds: number,
): RecordedFrame {
  return {
    sequence: 1,
    path,
    recordedAtMs,
    durationSeconds,
    width: 1280,
    height: 720,
  };
}

class FakeScreencastPage {
  listener?: (frame: Page_screencastFrame) => void;
  acknowledged: number[] = [];

  startScreencast(): Promise<void> {
    return Promise.resolve();
  }

  stopScreencast(): Promise<void> {
    return Promise.resolve();
  }

  acknowledgeScreencastFrame(sessionId: number): Promise<void> {
    this.acknowledged.push(sessionId);
    return Promise.resolve();
  }

  onScreencastFrame(
    listener: (frame: Page_screencastFrame) => void,
  ): () => void {
    this.listener = listener;
    return () => this.listener = undefined;
  }

  emit(frame: Page_screencastFrame): void {
    this.listener?.(frame);
  }
}

function screencastFrame(sessionId: number): Page_screencastFrame {
  return {
    sessionId,
    data: btoa("jpeg"),
    metadata: {
      offsetTop: 0,
      pageScaleFactor: 1,
      deviceWidth: 1280,
      deviceHeight: 720,
      scrollOffsetX: 0,
      scrollOffsetY: 0,
      timestamp: sessionId,
    },
  };
}
