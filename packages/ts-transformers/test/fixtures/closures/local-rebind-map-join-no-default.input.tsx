import { pattern, UI } from "commonfabric";

interface Room {
  name: string;
  messages: string[];
}

interface Conversation {
  rooms: Room[];
}

interface Input {
  conversation: Conversation;
}

// FIXTURE: local-rebind-map-join-no-default
// Verifies: same shape as CT-1562's failing repro (local rebind +
//   value-site .map().join() + JSX .map() of the same local) BUT
//   without `Default<[]>` on the rooms field. This baseline succeeds
//   at runtime (cf piece apply → "alpha: 2\nbeta: 0"), proving the
//   transformer lowering itself is correct.
// Context: companion to `local-rebind-map-join-value-site` which adds
//   `Default<[]>` and crashes at runtime. The crash is triggered by
//   the `anyOf: [{ items: false }, { items: ref }]` schema shape that
//   `Default<[]>` produces, not by the rebind.
// See packages/ts-transformers/docs/ct1562-investigation.md.
export default pattern<Input>(({ conversation }) => {
  const rooms = conversation.rooms;
  const roomSummaryText = rooms
    .map((room) => `${room.name}: ${room.messages.length}`)
    .join("\n");
  return {
    [UI]: (
      <div>
        {rooms.map((room) => <span>{room.name}</span>)}
        <p>{roomSummaryText}</p>
      </div>
    ),
    roomSummaryText,
  };
});
