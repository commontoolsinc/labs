/**
 * A FabriChat manager with a profile of its own, for
 * `fabrichat-spaces-multi-runtime.test.ts`. The real manager resolves its
 * user's profile with `#profile`, which no session of a multi-runtime harness
 * has, and starts no chat without one; this hands its core a stand-in. Its
 * records are its own inputs, defaulted, as the real manager's are.
 *
 * The harness's sessions share the space this manager lives in, and a room's
 * space refuses some of them, so each principal keeps the rooms and the people
 * it derives, which the core derives per user.
 */

import {
  type AddIntegrity,
  NAME,
  pattern,
  UI,
  VIEWS,
  Writable,
} from "commonfabric";
import {
  FabriChatManagerCore,
  type FabriChatManagerInput,
  type FabriChatManagerOutput,
} from "../../../fabrichat/manager.tsx";
import { type ChatProfile } from "../../../fabrichat/schemas.tsx";

/**
 * The stand-in profile, labeled, as a Fabric profile is, because a room's
 * participants link only a document that carries a label.
 */
type StandInProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

export default pattern<FabriChatManagerInput, FabriChatManagerOutput>(
  ({ sharedSpaceCatalog, direct, requests, outgoingNotices }) => {
    const profile = Writable.of<StandInProfile>({ name: "Starter" });
    const core = FabriChatManagerCore({
      myProfile: profile,
      sharedSpaceCatalog,
      direct,
      requests,
      outgoingNotices,
    });
    return {
      [NAME]: core[NAME],
      [UI]: core[UI],
      [VIEWS]: core[VIEWS],
      rooms: core.rooms,
      sharedSpaceCatalog: core.sharedSpaceCatalog,
      roomMembership: core.roomMembership,
      direct: core.direct,
      requests: core.requests,
      outgoingNotices: core.outgoingNotices,
      people: core.people,
      openDirect: core.openDirect,
      createGroup: core.createGroup,
      offerRoom: core.offerRoom,
      accept: core.accept,
      joinRoom: core.joinRoom,
      forget: core.forget,
      delivered: core.delivered,
    };
  },
);
