import { encodeBase64 } from "@std/encoding/base64";
import { extname, relative, resolve } from "@std/path";
import {
  HARNESS_IMAGE_ATTACHMENT_TYPE,
  type HarnessImageAttachment,
  type HarnessImageMediaType,
} from "./contracts/image.ts";
import type { OpenAIChatMessageContentPart } from "./gateway/openai-client.ts";

const MAX_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const IMAGE_MEDIA_TYPES = new Set<HarnessImageMediaType>([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const sha256Digest = async (content: Uint8Array): Promise<string> => {
  const digestInput = new ArrayBuffer(content.byteLength);
  new Uint8Array(digestInput).set(content);
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  return `sha256:${
    [...new Uint8Array(digest)].map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
  }`;
};

const mediaTypeFromExtension = (
  path: string,
): HarnessImageMediaType | undefined => {
  switch (extname(path).toLowerCase()) {
    case ".gif":
      return "image/gif";
    case ".jpeg":
    case ".jpg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      return undefined;
  }
};

const detectImageMediaType = (
  bytes: Uint8Array,
  path: string,
): HarnessImageMediaType | undefined => {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    ((bytes[0] === 0x47 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x38 &&
      bytes[4] === 0x37 &&
      bytes[5] === 0x61) ||
      (bytes[0] === 0x47 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x38 &&
        bytes[4] === 0x39 &&
        bytes[5] === 0x61))
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return mediaTypeFromExtension(path);
};

const assertPathWithinWorkspace = (
  workspaceHostPath: string,
  hostPath: string,
): void => {
  const relativePath = relative(workspaceHostPath, hostPath);
  if (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\")
  ) {
    throw new Error("--image paths must stay within the workspace");
  }
};

export const parseImageAttachmentPaths = (
  input: string | readonly string[] | undefined,
): string[] => {
  if (input === undefined) {
    return [];
  }
  const values: readonly string[] = Array.isArray(input) ? input : [input];
  if (values.length === 0) {
    return [];
  }
  const paths = values.flatMap((value) =>
    value.split(",").map((part) => part.trim()).filter((part) =>
      part.length > 0
    )
  );
  if (paths.length === 0) {
    throw new Error("--image requires a non-empty path");
  }
  return paths;
};

export const createHarnessImageAttachment = async (
  options: {
    workspaceHostPath: string;
    cwd: string;
    path: string;
  },
): Promise<HarnessImageAttachment> => {
  const workspaceHostPath = await Deno.realPath(options.workspaceHostPath);
  const hostPath = await Deno.realPath(resolve(options.cwd, options.path));
  assertPathWithinWorkspace(workspaceHostPath, hostPath);
  const stat = await Deno.stat(hostPath);
  if (!stat.isFile) {
    throw new Error(`--image path is not a file: ${options.path}`);
  }
  const bytes = await Deno.readFile(hostPath);
  if (bytes.byteLength === 0) {
    throw new Error(`--image path is empty: ${options.path}`);
  }
  if (bytes.byteLength > MAX_IMAGE_ATTACHMENT_BYTES) {
    throw new Error(
      `--image path is too large (${bytes.byteLength} bytes, max ${MAX_IMAGE_ATTACHMENT_BYTES}): ${options.path}`,
    );
  }
  const mediaType = detectImageMediaType(bytes, hostPath);
  if (mediaType === undefined || !IMAGE_MEDIA_TYPES.has(mediaType)) {
    throw new Error(
      `--image path is not a supported image type: ${options.path}`,
    );
  }
  return {
    type: HARNESS_IMAGE_ATTACHMENT_TYPE,
    hostPath,
    mediaType,
    bytes: bytes.byteLength,
    digest: await sha256Digest(bytes),
  };
};

export const materializeImageAttachmentContentPart = async (
  attachment: HarnessImageAttachment,
): Promise<OpenAIChatMessageContentPart> => {
  const bytes = await Deno.readFile(attachment.hostPath);
  if (bytes.byteLength !== attachment.bytes) {
    throw new Error(
      `image attachment changed after run start: ${attachment.hostPath}`,
    );
  }
  const digest = await sha256Digest(bytes);
  if (digest !== attachment.digest) {
    throw new Error(
      `image attachment digest changed after run start: ${attachment.hostPath}`,
    );
  }
  return {
    type: "image_url",
    image_url: {
      url: `data:${attachment.mediaType};base64,${encodeBase64(bytes)}`,
    },
  };
};
