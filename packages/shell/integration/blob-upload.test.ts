import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { env, waitFor } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";

const { FRONTEND_URL } = env;

describe("shell blob upload", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  it("uploads an image and displays it through a relative blobs path", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const spaceName = `blob-upload-${Date.now()}`;
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName },
      identity,
    });
    await waitFor(async () =>
      await shell.page().evaluate(() =>
        Boolean(
          (globalThis as unknown as {
            commonfabric?: { rt?: unknown };
          }).commonfabric?.rt,
        )
      )
    );

    const result = await shell.page().evaluate(async () => {
      const rt = (globalThis as unknown as {
        commonfabric?: {
          rt?: {
            uploadBlob(options: {
              contentType: string;
              body: Uint8Array;
              suffix?: string;
            }): Promise<{ id: string; url: string }>;
          };
          space?: string;
        };
      }).commonfabric?.rt;
      if (!rt) {
        throw new Error("Runtime client was not exposed");
      }

      const upload = await rt.uploadBlob({
        contentType: "image/gif",
        suffix: "gif",
        body: new Uint8Array([
          0x47,
          0x49,
          0x46,
          0x38,
          0x39,
          0x61,
          0x01,
          0x00,
          0x01,
          0x00,
          0x80,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0xff,
          0xff,
          0xff,
          0x2c,
          0x00,
          0x00,
          0x00,
          0x00,
          0x01,
          0x00,
          0x01,
          0x00,
          0x00,
          0x02,
          0x02,
          0x44,
          0x01,
          0x00,
          0x3b,
        ]),
      });

      const image = document.createElement("img");
      image.setAttribute("data-blob-upload-test", "true");
      image.src = upload.url;
      document.body.append(image);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out loading uploaded image")),
          5000,
        );
        image.onload = () => {
          clearTimeout(timeout);
          resolve();
        };
        image.onerror = () => {
          clearTimeout(timeout);
          reject(new Error(`Failed to load ${image.currentSrc}`));
        };
      });

      return {
        relativeUrl: upload.url,
        currentSrc: image.currentSrc,
        width: image.naturalWidth,
        height: image.naturalHeight,
      };
    });

    await waitFor(() => Promise.resolve(result.width === 1));

    expect(result.relativeUrl.startsWith("blobs/")).toBe(true);
    expect(result.currentSrc).toContain("/did:key:");
    expect(result.currentSrc).toContain("/blobs/");
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
  });
});
