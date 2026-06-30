export function getOcrErrorText(error: unknown): string | undefined {
  if (!error) {
    return undefined;
  }

  if (typeof error === "string") {
    return error;
  }

  if (typeof error === "object" && "message" in error) {
    const message = error.message;
    if (message) {
      return String(message);
    }
  }

  return String(error);
}
