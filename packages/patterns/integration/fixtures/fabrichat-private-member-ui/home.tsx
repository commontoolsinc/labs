/** A Home with real profiles and manager actions behind a private manager face. */
import {
  type Confidential,
  NAME,
  pattern,
  type Stream,
  UI,
} from "commonfabric";
import type { FabriChatManagerOutput } from "../../../fabrichat/manager.tsx";
import type {
  RoomManager,
  StartDirectEvent,
} from "../../../fabrichat/room.tsx";
import Home, {
  type MainInput,
  type MainOutput,
} from "../fabrichat-add-offer/main.tsx";

// The browser fixture substitutes its identity's DID before compiling.
const PERSONAL = {
  type: "https://commonfabric.org/cfc/atom/PersonalSpace",
  owner: "did:key:z6MkqonmiAA2fg5wAEkagDYr8ghbNvmRD4QBTCB8tihLvHuN",
} as const;

type Manager = RoomManager & { openDirect: Stream<StartDirectEvent> };

type PersonalManager = Confidential<
  Manager,
  readonly [typeof PERSONAL]
>;

/** Keeps a declared root label on the document the room's wish reaches. */
const PrivateManager = pattern<
  { manager: FabriChatManagerOutput },
  PersonalManager
>(({ manager }) =>
  ({
    offerRoom: manager.offerRoom,
    joinRoom: manager.joinRoom,
    openDirect: manager.openDirect,
    requests: manager.requests,
    people: manager.people,
  }) as PersonalManager
);

type Output = Omit<MainOutput, "chatManager"> & {
  chatManager: Manager;
};

export default pattern<MainInput, Output>((input) => {
  const home = Home(input);
  return {
    [NAME]: home[NAME],
    [UI]: home[UI],
    privateInbox: home.privateInbox,
    retainedPrivateInboxes: home.retainedPrivateInboxes,
    privateInboxRefusal: home.privateInboxRefusal,
    profiles: home.profiles,
    ensurePrivateInbox: home.ensurePrivateInbox,
    createProfile: home.createProfile,
    createGroup: home.createGroup,
    requests: home.requests,
    chatManager: PrivateManager({ manager: home.chatManager }) as Manager,
  };
});
