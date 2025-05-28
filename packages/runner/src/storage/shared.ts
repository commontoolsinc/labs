import { debug } from "@commontools/html";

// This type is used to tag a document with any important metadata.
// Currently, the only supported type is the classification.
export type Labels = {
  classification?: string[];
};

export function log(fn: () => any[]) {
  debug(() => {
    // Get absolute time in milliseconds since Unix epoch
    const absoluteMs = (performance.timeOrigin % 3600000) +
      (performance.now() % 1000);

    // Extract components
    const totalSeconds = Math.floor(absoluteMs / 1000);
    const minutes = Math.floor((totalSeconds % 3600) / 60)
      .toString()
      .padStart(2, "0");
    const seconds = (totalSeconds % 60).toString().padStart(2, "0");
    const millis = Math.floor(absoluteMs % 1000)
      .toString()
      .padStart(3, "0");

    const timestamp = `${minutes}:${seconds}.${millis}`;

    const storagePrefix = `%c[storage:${timestamp}]`;
    const storageStyle = "color: #10b981; font-weight: 500;";

    return [storagePrefix, storageStyle, ...fn()];
  });
}