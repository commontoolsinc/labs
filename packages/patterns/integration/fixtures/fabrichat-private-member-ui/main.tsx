/** Isolates production member-picker observations with populated manager data. */
import { type Cell, pattern } from "commonfabric";
import {
  AddMember,
  type AddMemberOutput,
  type AddRequestsCell,
  type RoomManager,
} from "../../../fabrichat/room.tsx";
import type { MessagesCell } from "../../../fabrichat/room-records.tsx";
import type { ChatProfile } from "../../../fabrichat/schemas.tsx";

interface Input {
  profile: Cell<ChatProfile>;
  manager?: Cell<RoomManager>;
  records: MessagesCell;
  addRequests: AddRequestsCell;
}

export default pattern<Input, AddMemberOutput>((input) =>
  AddMember({
    room: input.records,
    myProfile: input.profile,
    manager: input.manager,
    requests: input.addRequests,
    ownSpace: true,
    kind: "group",
    present: [],
  })
);
