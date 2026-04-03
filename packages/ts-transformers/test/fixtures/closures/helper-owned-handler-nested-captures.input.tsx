/// <cts-enable />
/**
 * TRANSFORM REPRO: helper-owned handler with nested callback captures
 *
 * Compare on main vs transformer branch:
 *   deno task ct check packages/patterns/gideon-tests/test-helper-owned-handler-nested-captures.tsx --show-transformed --no-run
 *
 * Expected main shape:
 * - generated handler state includes `timer`, `fileId`, `content`,
 *   `savedContent`, and `onSaveFile`
 *
 * Current branch bug:
 * - generated handler state only includes `timer`, while the handler body
 *   still uses the other captures inside the nested `setTimeout(...)` callback
 */
import { action, Default, pattern, Stream, Writable } from "commonfabric";

function flushLater(
  fileId: Writable<Default<string, "">>,
  content: Writable<Default<string, "">>,
  savedContent: Writable<Default<string, "">>,
  onSaveFile: Stream<{ fileId: string; content: string }>,
): void {
  const nextContent = content.get();
  const lastSaved = savedContent.get();
  const targetFileId = fileId.get().trim();
  if (!targetFileId || nextContent === lastSaved) return;
  onSaveFile.send({ fileId: targetFileId, content: nextContent });
}

interface Input {
  fileId: Writable<Default<string, "">>;
  content: Writable<Default<string, "">>;
  savedContent: Writable<Default<string, "">>;
  onSaveFile: Stream<{ fileId: string; content: string }>;
}

interface Output {
  trigger: Stream<void>;
}

export default pattern<Input, Output>(
  ({ fileId, content, savedContent, onSaveFile }) => {
    const timer = Writable.of<ReturnType<typeof setTimeout> | null>(null);

    const trigger = action(() => {
      const prev = timer.get();
      if (prev !== null) clearTimeout(prev);
      timer.set(
        setTimeout(() => {
          flushLater(fileId, content, savedContent, onSaveFile);
        }, 10),
      );
    });

    return { trigger };
  },
);
