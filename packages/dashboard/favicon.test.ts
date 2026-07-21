import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  FAVICON_VERSION,
  type FaviconFace,
  faviconHref,
  faviconLink,
  faviconPng,
  faviconStatus,
} from "./favicon.ts";
import { faviconSvg } from "./favicon-artwork.ts";
import { FAVICON_FACES } from "./favicon-types.ts";

Deno.test("faviconStatus: red wins, then orange, and gray never replaces green", () => {
  assertEquals(faviconStatus([]), "good");
  assertEquals(faviconStatus(["unknown"]), "good");
  assertEquals(faviconStatus(["good", "unknown"]), "good");
  assertEquals(faviconStatus(["warn", "good", "unknown"]), "warn");
  assertEquals(faviconStatus(["warn", "bad", "good"]), "bad");
  assertEquals(faviconStatus(["bad", "warn"]), "bad");
});

Deno.test("favicon artwork: each face has one matching URL-backed raster icon", () => {
  const artwork: Record<
    FaviconFace,
    { color: string; mouth: string; detail?: string }
  > = {
    good: {
      color: "#43c574",
      mouth: `d="M11 19c2.8 2.6 7.2 2.6 10 0"`,
    },
    warn: { color: "#e0a852", mouth: `d="M11 20h10"` },
    bad: {
      color: "#e2504a",
      mouth: `d="M11 21c2.8-2.6 7.2-2.6 10 0"`,
    },
    "bad-crying": {
      color: "#e2504a",
      mouth: `d="M10.5 22c3-4 8-4 11 0"`,
      detail: `fill="#9edcff"`,
    },
  };
  for (
    const [status, { color, mouth, detail }] of Object.entries(artwork) as [
      FaviconFace,
      { color: string; mouth: string; detail?: string },
    ][]
  ) {
    assertEquals(
      faviconHref(status),
      `/favicon.png?status=${status}&v=${FAVICON_VERSION}`,
    );
    if (status !== "bad-crying") {
      const link = faviconLink(status);
      assertStringIncludes(
        link,
        `type="image/png" sizes="32x32" href="/favicon.png?status=${status}&v=${FAVICON_VERSION}"`,
      );
      assertEquals((link.match(/rel="icon"/g) ?? []).length, 1);
      assert(!link.includes("image/svg+xml"));
    }
    const svg = faviconSvg(status);
    assertStringIncludes(svg, `fill="${color}"`);
    assertStringIncludes(svg, `<circle cx="12" cy="14"`);
    assertStringIncludes(svg, `<path ${mouth}`);
    if (detail) assertStringIncludes(svg, detail);
    if (status === "bad-crying") {
      assertStringIncludes(svg, `d="M12 16.5`);
      assertEquals((svg.match(/fill="#9edcff"/g) ?? []).length, 1);
      assert(!svg.includes(`d="M20 16.5`), "the right eye has no tear");
    }
    if (status !== "good") {
      assert(
        !svg.includes(`d="M11 19c2.8 2.6 7.2 2.6 10 0"`),
        `${status} has no smile`,
      );
    }
  }
});

Deno.test("faviconPng: each status has a distinct 32-pixel PNG and unsupported statuses stay green", () => {
  const signature = new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
  ]);
  const encoded: string[] = [];
  for (const status of FAVICON_FACES) {
    const png = new Uint8Array(faviconPng(status));
    assertEquals(png.slice(0, signature.length), signature);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    assertEquals(view.getUint32(16), 32);
    assertEquals(view.getUint32(20), 32);
    encoded.push(png.toBase64());
  }
  assertEquals(new Set(encoded).size, 4);
  assertEquals(
    new Uint8Array(faviconPng("unknown")),
    new Uint8Array(faviconPng("good")),
  );
  assertEquals(
    new Uint8Array(faviconPng(null)),
    new Uint8Array(faviconPng("good")),
  );
});

Deno.test("favicon cache version is derived from all generated PNGs", async () => {
  const encoded = FAVICON_FACES.map((face) =>
    `${face}\0${new Uint8Array(faviconPng(face)).toBase64()}`
  ).join("\0");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded)),
  );
  const expected = Array.from(
    digest,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  assertEquals(FAVICON_VERSION, expected);
});
