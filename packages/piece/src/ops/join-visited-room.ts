/**
 * Joining a FabriChat room the user visits: the host vets the visited space
 * as a FabriChat room the user can write to, and tells Home's chat manager the
 * user has joined it, through its `joinRoom`. The manager makes the room one
 * of the user's chats, lists a forgotten one again, and leaves one they have
 * as it is. Which visits count as joining is the host's choice;
 * `docs/features/private-inbox.md` describes the labs shell's.
 */

import type { DID } from "@commonfabric/identity";
import {
  type Cell,
  isCell,
  type Runtime,
  sendEvent,
} from "@commonfabric/runner";
import { CHAT_ROOM_SPACE_KIND } from "./share-intake.ts";
import { type SpaceRefusal, vetSpace } from "./space-vetting.ts";

/**
 * What came of a visit: `sent` to the chat manager's `joinRoom`, skipped as
 * `no-chat-manager` for a Home whose chat manager has no `joinRoom`, or
 * refused, for the reason vetting gives.
 */
export type JoinVisitDecision = "sent" | "no-chat-manager" | SpaceRefusal;

/**
 * Tells the chat manager of `home`, the Home of `identity`, that the identity
 * has joined the room whose space is `space`, when the space passes vetting
 * as `vetSpace()` says, for a space of kind `fabrichat-room`: the identity
 * can write there, and the space's root is the room. The event names the root
 * and no `requestId`, so the manager records nothing for a room the identity's
 * chats list already.
 *
 * Resolves once the event is sent, which is before the manager has handled
 * it.
 *
 * @throws When reading what vetting needs fails other than by a refusal of
 *   access, or when the host cannot tell the space's kind.
 */
export async function joinVisitedRoomOf(
  runtime: Runtime,
  home: Cell<unknown>,
  identity: DID,
  space: DID,
): Promise<JoinVisitDecision> {
  const joinRoom = home.key("chatManager").key("joinRoom");
  if (joinRoom.getRaw() === undefined) return "no-chat-manager";
  const vetted = await vetSpace(runtime, space, identity, CHAT_ROOM_SPACE_KIND);
  if (!isCell(vetted)) return vetted;
  sendEvent(joinRoom, { room: vetted });
  return "sent";
}
