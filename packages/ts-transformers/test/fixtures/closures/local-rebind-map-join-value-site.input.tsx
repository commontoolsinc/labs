import { Default, pattern, UI } from "commonfabric";

interface Room {
  name: string;
  messages: string[] | Default<[]>;
}

interface Conversation {
  rooms: Room[] | Default<[]>;
}

interface Input {
  conversation: Conversation;
}

// FIXTURE: local-rebind-map-join-value-site
// Verifies (CT-1562): when a local rebinds a reactive property
//   (`const rooms = conversation.rooms`) and is used both inside JSX
//   (`rooms.map(...)` → mapWithPattern) and in a non-JSX value-site
//   expression (`rooms.map(...).join(...)` → derive), the value-site
//   derive must receive the unwrapped array rather than the key-cell.
// Bug: today the derive callback is invoked with `rooms` still being a
//   cell (key-cell from `.key("rooms")`), so `rooms.map(...)` throws
//   `TypeError: rooms.map is not a function` at runtime.
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
