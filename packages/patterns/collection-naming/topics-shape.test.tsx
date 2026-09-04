/**
 * The Topics-shape rehearsal: a test-only board whose members are the real
 * Topic pattern, unmodified, wired through the naming library the way the
 * exemplar board is. What it proves is the board side — allocation on
 * create, the backfill over a list filed before the board numbered anything,
 * index rows carrying `name`, and the names table giving a topic its name by
 * identity. The item side is proven on the exemplar item.
 */
import {
  action,
  assert,
  type ComparableCell,
  Default,
  equals,
  lift,
  NAME,
  pattern,
  type ReadonlyCell,
  Stream,
  TESTS,
  Writable,
} from "commonfabric";
import type { TopicDemand } from "../topics/main.tsx";
import Topic, {
  rejectMutation,
  topicAuthorFromAgent,
} from "../topics/topic.tsx";
import {
  assignName,
  backfillNames,
  nameOf,
  type NamesMap,
  namesTable,
  type NamesTableRow,
  type NamingDeclaration,
  SEQUENCE_NAMING,
} from "./naming.ts";

interface ShapeInput {
  topics?: Writable<TopicDemand[] | Default<[]>>;
  // deno-lint-ignore ban-types
  names?: Writable<Default<NamesMap, {}>>;
}

interface AddShapeEvent {
  title: string;
  body?: string;
  agentName: string;
}

/** The index row the rehearsal publishes: the topic as a reference, the
 * scalars a survey reads, and the board's name for it, defaulted. */
interface ShapeIndexRow {
  member: unknown;
  title: string | Default<"">;
  createdAt: number | Default<0>;
  name: string | Default<"">;
}

interface ShapeOutput {
  [NAME]: string;
  topics: TopicDemand[];
  index: ShapeIndexRow[] | Default<[]>;
  // deno-lint-ignore ban-types
  names: Default<NamesMap, {}>;
  namesTable: NamesTableRow[] | Default<[]>;
  naming: NamingDeclaration;
  addTopic: Stream<AddShapeEvent, { topic: ShapeIndexRow }>;
  backfillNames: Stream<{ agentName: string }, { assigned: string[] }>;
}

/** The rehearsal's index rows, addressed by the topic each describes. */
const shapeIndex = lift(
  (
    { members, table }: {
      members:
        | ReadonlyCell<{
          title: string | Default<"">;
          createdAt: number | Default<0>;
        }>[]
        | Default<[]>;
      table: { member: ComparableCell<unknown>; name: string }[] | Default<[]>;
    },
  ): ShapeIndexRow[] => {
    const rows: unknown[] = [];
    for (const member of Array.from(members)) {
      const value = member?.get();
      if (!member || !value) continue;
      const name = nameOf(member, table);
      const row = {
        member,
        title: value.title ?? "",
        createdAt: value.createdAt ?? 0,
        ...(name === undefined ? {} : { name }),
      } as ShapeIndexRow;
      rows.push(Writable.for<ShapeIndexRow>(member).set(row));
    }
    return rows as ShapeIndexRow[];
  },
);

/**
 * A board over real topics that names its members: `addTopic` as the Topics
 * board writes it, plus the one line that allocates the name in the same
 * transaction as the append.
 */
const ShapeBoard = pattern<ShapeInput, ShapeOutput>(({ topics, names }) => {
  const topicCount = topics.get().length;
  const table = namesTable({ names });
  const index = shapeIndex({ members: topics, table });

  const addTopic = action<AddShapeEvent, { topic: ShapeIndexRow }>(
    ({ title, body, agentName }) => {
      const trimmed = (title ?? "").trim();
      const author = topicAuthorFromAgent(agentName) ??
        rejectMutation("addTopic", "agentName must be non-blank");
      if (!trimmed) rejectMutation("addTopic", "title must be non-empty");
      const createdAt = Date.now();
      const piece = Topic({
        title: trimmed,
        body: body ?? "",
        createdAt,
        createdBy: author,
      });
      const name = assignName(names, piece);
      topics.push(piece);
      return { topic: { member: piece, title: trimmed, createdAt, name } };
    },
  );

  const backfill = action<{ agentName: string }, { assigned: string[] }>(
    ({ agentName }) => {
      if (!topicAuthorFromAgent(agentName)) {
        rejectMutation("backfillNames", "agentName must be non-blank");
      }
      return { assigned: backfillNames(topics, names) };
    },
  );

  return {
    [NAME]: `Topics (${topicCount})`,
    topics,
    index,
    names,
    namesTable: table,
    naming: SEQUENCE_NAMING,
    addTopic,
    backfillNames: backfill,
  };
});

export default pattern(() => {
  const topics = new Writable<TopicDemand[] | Default<[]>>([]);
  const names = new Writable<NamesMap>({});
  const board = ShapeBoard({ topics, names });

  const assert_initial = assert(() =>
    (board.topics ?? []).length === 0 &&
    (board.index ?? []).length === 0 &&
    (board.namesTable ?? []).length === 0 &&
    board[NAME] === "Topics (0)"
  );

  // Allocation on create, through the real Topic's create path.
  const action_add_first = action(() => {
    board.addTopic.send({
      title: "First topic",
      body: "The living document.",
      agentName: "Sol",
    });
  });
  const action_add_second = action(() => {
    board.addTopic.send({ title: "Second topic", agentName: "Fable" });
  });
  const assert_allocated_on_create = assert(() =>
    (board.topics ?? []).length === 2 &&
    board.topics?.[0]?.title === "First topic" &&
    board.topics?.[0]?.createdBy?.name === "Sol" &&
    board.index?.[0]?.name === "1" &&
    board.index?.[0]?.title === "First topic" &&
    board.index?.[1]?.name === "2" &&
    board.index?.[1]?.title === "Second topic" &&
    equals(
      ((board.names ?? {}) as NamesMap)["1"] as object,
      board.topics?.[0] as object,
    ) &&
    equals(
      ((board.names ?? {}) as NamesMap)["2"] as object,
      board.topics?.[1] as object,
    )
  );

  // The names-table row for a given topic, looked up by the identity a
  // caller holds — here the list position's cell — returns its name.
  const assert_table_row_for_a_topic = assert(() =>
    (board.namesTable ?? []).length === 2 &&
    nameOf(topics.key(0), board.namesTable ?? []) === "1" &&
    nameOf(topics.key(1), board.namesTable ?? []) === "2"
  );

  // The bound: topics carry bodies and threads, and neither the namespace
  // nor the index carries any of it.
  const assert_reads_expand_no_topic = assert(() => {
    const namespace = JSON.stringify(board.names);
    const index = JSON.stringify(board.index);
    return !namespace.includes('"title"') &&
      !namespace.includes('"body"') &&
      index.includes('"title"') &&
      !index.includes('"body"') &&
      !index.includes('"comments"') &&
      !index.includes('"addComment"') &&
      !index.includes("vnode");
  });

  // The backfill, on a board whose topics were filed before it numbered
  // anything: pushed straight into the list, the way an existing board
  // holds them.
  const olderTopics = new Writable<TopicDemand[] | Default<[]>>([]);
  const olderNames = new Writable<NamesMap>({});
  const older = ShapeBoard({ topics: olderTopics, names: olderNames });

  const action_file_unnamed_topics = action(() => {
    olderTopics.push(Topic({ title: "Older one", createdAt: 1 }));
    olderTopics.push(Topic({ title: "Older two", createdAt: 2 }));
  });
  const assert_unnamed_rows_read_the_default = assert(() =>
    (older.index ?? []).length === 2 &&
    older.index?.[0]?.name === "" &&
    older.index?.[1]?.name === "" &&
    (older.namesTable ?? []).length === 0
  );
  const action_backfill = action(() => {
    older.backfillNames.send({ agentName: "Sol" });
  });
  const assert_backfilled_in_filing_order = assert(() =>
    older.index?.[0]?.name === "1" &&
    older.index?.[0]?.title === "Older one" &&
    older.index?.[1]?.name === "2" &&
    older.index?.[1]?.title === "Older two" &&
    equals(
      ((older.names ?? {}) as NamesMap)["1"] as object,
      older.topics?.[0] as object,
    ) &&
    equals(
      ((older.names ?? {}) as NamesMap)["2"] as object,
      older.topics?.[1] as object,
    )
  );
  const action_backfill_again = action(() => {
    older.backfillNames.send({ agentName: "Sol" });
  });
  const assert_second_backfill_leaves_the_map = assert(() =>
    Object.keys((older.names ?? {}) as NamesMap).join(",") === "1,2" &&
    equals(
      ((older.names ?? {}) as NamesMap)["1"] as object,
      older.topics?.[0] as object,
    ) &&
    equals(
      ((older.names ?? {}) as NamesMap)["2"] as object,
      older.topics?.[1] as object,
    )
  );
  // A create after the backfill continues the sequence.
  const action_add_after_backfill = action(() => {
    older.addTopic.send({ title: "Newer one", agentName: "Sol" });
  });
  const assert_create_continues_the_sequence = assert(() =>
    (older.topics ?? []).length === 3 &&
    older.index?.[2]?.name === "3" &&
    Object.keys((older.names ?? {}) as NamesMap).join(",") === "1,2,3"
  );

  const assert_declaration = assert(() =>
    board.naming?.policy?.allocator === "sequence" &&
    board.naming?.policy?.unique === "history" &&
    board.naming?.compact === true
  );

  return {
    [TESTS]: [
      { assertion: assert_initial },
      { action: action_add_first },
      { action: action_add_second },
      { assertion: assert_allocated_on_create },
      { assertion: assert_table_row_for_a_topic },
      { assertion: assert_reads_expand_no_topic },
      { action: action_file_unnamed_topics },
      { assertion: assert_unnamed_rows_read_the_default },
      { action: action_backfill },
      { assertion: assert_backfilled_in_filing_order },
      { action: action_backfill_again },
      { assertion: assert_second_backfill_leaves_the_map },
      { action: action_add_after_backfill },
      { assertion: assert_create_continues_the_sequence },
      { assertion: assert_declaration },
    ],
  };
});
