import { equals, handler, Writable } from "commonfabric";

type MentionablePiece = {
  title?: string;
  isHidden?: boolean;
  mentioned?: MentionablePiece[];
  backlinks?: MentionablePiece[];
};

const addPiece = handler<
  { piece: MentionablePiece },
  { pieceRegistry: Writable<MentionablePiece[]> }
>((event, { pieceRegistry }) => {
  const piece = event?.piece;
  if (!piece) return;

  const current = pieceRegistry.get();
  if (!current.some((c) => equals(c, piece))) {
    pieceRegistry.push(piece);
  }
});

const trackRecent = handler<
  { piece: MentionablePiece },
  { recentPieces: Writable<MentionablePiece[]> }
>(({ piece }, { recentPieces }) => {
  const current = recentPieces.get();
  const filtered = current.filter((c) => !equals(c, piece));
  const updated = [piece, ...filtered].slice(0, 10);
  recentPieces.set(updated);
});

// FIXTURE: identity-only-handler-payload
// Verifies: handler payloads and array items used only for identity/passthrough
// shrink to unknown instead of retaining full recursive structural schemas.
export { addPiece, trackRecent };
