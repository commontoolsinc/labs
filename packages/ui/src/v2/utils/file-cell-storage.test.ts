import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { RuntimeClient } from "@commonfabric/runtime-client";
import {
  fileSuffix,
  fileToDataUrl,
  sanitizeFileName,
  uploadFile,
} from "./file-cell-storage.ts";

describe("file-cell-storage", () => {
  it("encodes blobs as data urls when requested", async () => {
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    expect(await fileToDataUrl(file)).toBe("data:text/plain;base64,aGVsbG8=");
  });

  it("sanitizes filenames and derives suffixes", () => {
    expect(sanitizeFileName(" My Screen Shot 1.png ")).toBe(
      "My-Screen-Shot-1.png",
    );
    expect(sanitizeFileName("")).toBe("file");
    expect(fileSuffix("no-extension", "image/png")).toBe("png");
    expect(fileSuffix("report.final.PDF", "application/octet-stream")).toBe(
      "pdf",
    );
  });

  it("uploads bytes through RuntimeClient and returns a descriptor", async () => {
    let request: unknown;
    const runtime = {
      uploadBlob: (options: unknown) => {
        request = options;
        return Promise.resolve({
          id: "fid1:test",
          url: "blobs/test.txt",
        });
      },
    } as unknown as RuntimeClient;

    const file = new File(["hello"], "hello world.txt", {
      type: "text/plain",
    });
    const stored = await uploadFile({
      file,
      runtime,
      includeDataUrl: true,
    });

    expect(request).toMatchObject({
      contentType: "text/plain",
      suffix: "txt",
    });
    expect((request as { body: Uint8Array }).body).toEqual(
      new Uint8Array([104, 101, 108, 108, 111]),
    );
    expect(stored).toMatchObject({
      id: "fid1:test",
      name: "hello world.txt",
      url: "blobs/test.txt",
      mediaType: "text/plain",
      type: "text/plain",
      size: 5,
      data: "data:text/plain;base64,aGVsbG8=",
    });
  });
});
