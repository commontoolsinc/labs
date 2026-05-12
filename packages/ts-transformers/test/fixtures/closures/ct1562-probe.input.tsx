// FIXTURE: ct1562-probe
// CT-1562 instrumented investigation probe (Default<[]> variant).
//
// Same shape as the failing fixture (with Default<[]>) but the derive
// callback also calls `inspectRooms` — a module-scope helper — so we
// can observe what `rooms` actually is at runtime when the schema has
// the anyOf split (`{ type: "array", items: false }` vs
// `{ items: { $ref: ... } }`).
//
// When deployed via `cf piece new <this>.tsx` and applied, the probe
// prints:
//   CT1562_PROBE: { isArray: false, ctor: "Object", keys: ["0","1"],
//                   hasMap: false, mapError: "TypeError: r.map ..." }
// — i.e., `rooms` arrives as a plain object with numeric keys, not an
// array. That's the proximate cause of the `rooms.map is not a function`
// crash in Berni's report.
//
// Kept committed because the probe scaffold (module-scope helper +
// derived value-site derive) is useful for re-investigating any other
// schema-traversal merge bugs. Allowed to bit-rot per the diagnostics
// convention (see test/diagnostics/README.md).
// See packages/ts-transformers/docs/ct1562-investigation.md.
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

// Module-scope helper — runs inside the derive callback after the
// transformer lowers the value-site expression.
function inspectRooms(rooms: unknown): string {
  // deno-lint-ignore no-explicit-any
  const r: any = rooms;
  const info: Record<string, unknown> = {
    type: typeof r,
    isArray: Array.isArray(r),
    ctor: r?.constructor?.name,
    keys: r && typeof r === "object"
      ? Object.keys(r).slice(0, 10)
      : undefined,
    hasGet: typeof r?.get === "function",
    hasMap: typeof r?.map === "function",
    len: r?.length,
    proto: r ? Object.getPrototypeOf(r)?.constructor?.name : undefined,
  };
  try {
    const mapped = r.map((room: { name?: string; messages?: unknown[] }) =>
      `${room?.name}: ${room?.messages?.length}`
    );
    info.mappedOk = true;
    info.mapped = mapped;
  } catch (e) {
    info.mappedOk = false;
    info.mapError = String(e);
  }
  console.log("CT1562_PROBE:", JSON.stringify(info));
  return "probe:" + JSON.stringify(info);
}

export default pattern<Input>(({ conversation }) => {
  const rooms = conversation.rooms;
  // Drive a derive over `rooms` but use only the probe helper — no
  // direct .map().join() reference here.
  const roomSummaryText = inspectRooms(rooms) + " | len=" + rooms.length;
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
