export const HARNESS_IMAGE_ATTACHMENT_TYPE = "cf-harness.image-attachment";

export type HarnessImageMediaType =
  | "image/gif"
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export interface HarnessImageAttachment {
  type: typeof HARNESS_IMAGE_ATTACHMENT_TYPE;
  hostPath: string;
  mediaType: HarnessImageMediaType;
  bytes: number;
  digest: string;
}
