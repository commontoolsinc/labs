import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
import * as Repository from "../store.ts";
import { refer, createTemporaryDirectory } from "../util.ts";
import { ensureSymlink } from "@std/fs/ensure-symlink";
import { transaction } from "../error.ts";

const the = "application/json";
const doc = "baedreigv6dnlwjzyyzk2z2ld2kapmu6hvqp46f3axmgdowebqgbts5jksi";
const space = "did:key:z6MkffDZCkCTWreg8868fG1FGFogcJj5X6PY93pPcWDn9bob";
const alice = "did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi";

const test = (title: string, url: URL, run: (replica: Repository.Store) => Promise<unknown>) => {
  const unit = async () => {
    const session = await Repository.open({
      url,
    });

    assert(session.ok, "Open create repository if it does not exist");

    try {
      await run(session.ok);
    } finally {
      await Repository.close(session.ok);
    }
  };

  if (title.startsWith("only")) {
    Deno.test.only(title, unit);
  } else if (title.startsWith("skip")) {
    Deno.test.ignore(title, unit);
  } else {
    Deno.test(title, unit);
  }
};

test(
  "querying non existing memory returns implicit fact",
  new URL(`memory:${alice}`),
  async (session) => {
    const result = await Repository.query(session, {
      the: "application/json",
      of: doc,
    });

    assertEquals(
      result,
      {
        ok: {
          the: "application/json",
          of: doc,
        },
      },
      "Implicit fact",
    );
  },
);

test("create new memory", new URL(`memory:${space}`), async (session) => {
  const v1 = {
    the: "application/json",
    of: doc,
    is: { v: 1 },
  };
  const result = await Repository.transact(session, {
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [refer({ the, of: doc }).toString()]: {
            is: { v: 1 },
          },
        },
      },
    },
  });

  assertEquals(result, {
    ok: {
      the: "application/json",
      of: refer(space).toString(),
      is: {
        since: 0,
        transaction: {
          issuer: alice,
          subject: space,
          changes: {
            [the]: {
              [doc]: {
                [refer({ the, of: doc }).toString()]: {
                  is: { v: 1 },
                },
              },
            },
          },
        },
      },
      cause: refer({
        the: the,
        of: refer(space).toString(),
      }),
    },
  });

  const read = Repository.query(session, {
    the: "application/json",
    of: doc,
  });

  assertEquals(read, {
    ok: {
      the: "application/json",
      of: doc,
      is: { v: 1 },
      cause: refer({
        the: "application/json",
        of: doc,
      }),
    },
  });
});

test("explicit empty creation", new URL(`memory:${space}`), async (session) => {
  assertEquals(await Repository.query(session, { the: "application/json", of: doc }), {
    ok: {
      the: "application/json",
      of: doc,
    },
  });

  const transaction = {
    issuer: alice,
    subject: space,
    changes: {
      [the]: { [doc]: { [refer({ the, of: doc }).toString()]: { is: {} } } },
    },
  };

  assertEquals(await Repository.transact(session, transaction).ok?.is.since, 0);
  assertEquals(await Repository.transact(session, transaction).ok?.is.since, 1);

  assertEquals(await Repository.query(session, { the: "application/json", of: doc }), {
    ok: {
      the: "application/json",
      of: doc,
      is: {},
      cause: refer({
        the: "application/json",
        of: doc,
      }),
    },
  });
});

test("explicit {}", new URL(`memory:${space}`), async (session) => {
  const create = {
    subject: space,
    issuer: alice,
    changes: {
      [the]: {
        [doc]: {
          [refer({ the, of: doc }).toString()]: {
            is: {},
          },
        },
      },
    },
  };

  const init = await Repository.transact(session, create);

  assertEquals(init, {
    ok: {
      the,
      of: refer(space).toString(),
      is: {
        since: 0,
        transaction: create,
      },
      cause: refer({
        the,
        of: refer(space).toString(),
      }),
    },
  });

  const update = {
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [refer({ the, of: doc, is: {}, cause: refer({ the, of: doc }) }).toString()]: {
            is: { v: 1 },
          },
        },
      },
    },
  };

  assertEquals(await Repository.transact(session, update), {
    ok: {
      the,
      of: refer(space).toString(),
      is: {
        since: 1,
        transaction: update,
      },
      cause: refer(init.ok),
    },
  });
});

test("updates memory", new URL(`memory:${space}`), async (session) => {
  const init = {
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [Repository.init({ the, of: doc }).toString()]: {
            is: { v: 0 },
          },
        },
      },
    },
  };

  const create = await Repository.transact(session, init);

  assertEquals(create, {
    ok: {
      the,
      of: refer(space).toString(),
      is: {
        since: 0,
        transaction: init,
      },
      cause: refer({
        the,
        of: refer(space).toString(),
      }),
    },
  });

  const change = {
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [refer({
            the,
            of: doc,
            is: { v: 0 },
            cause: Repository.init({ the, of: doc }),
          }).toString()]: {
            is: { v: 1 },
          },
        },
      },
    },
  };

  const update = await Repository.transact(session, change);

  assertEquals(
    update,
    {
      ok: {
        the,
        of: refer(space).toString(),
        is: {
          transaction: change,
          since: 1,
        },
        cause: refer(create.ok),
      },
    },
    "updates document",
  );
});

test("fails updating non-existing memory", new URL(`memory:${space}`), async (session) => {
  const v1 = {
    the: "application/json",
    of: doc,
    is: { v: 2 },
  };

  const result = await Repository.transact(session, {
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [refer(v1).toString()]: {
            is: { v: 2 },
          },
        },
      },
    },
  });

  assert(result.error, "Update should fail if document does not exists");
  assert(result.error.name === "ConflictError");
  assertEquals(result.error.conflict, {
    in: space,
    the: "application/json",
    of: doc,
    expected: refer(v1),
    actual: null,
  });
});

test("create memory fails if already exists", new URL(`memory:${space}`), async (session) => {
  const base = refer({ the, of: doc });
  const create = {
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [base.toString()]: {
            is: { v: 0 },
          },
        },
      },
    },
  };

  const init = await Repository.transact(session, create);

  assert(init.ok, "Document created");

  const createRace = {
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [base.toString()]: {
            is: { v: 1 },
          },
        },
      },
    },
  };

  const conflict = await Repository.transact(session, createRace);

  assert(conflict.error, "Create fail when already exists");
  assert(conflict.error.name === "ConflictError");
  assertEquals(conflict.error.conflict, {
    in: space,
    the: "application/json",
    of: doc,
    expected: null,
    actual: {
      the: "application/json",
      of: doc,
      is: { v: 0 },
      cause: refer({ the: "application/json", of: doc }),
    },
  });
});

test("concurrent update fails", new URL(`memory:${alice}`), async (session) => {
  const base = refer({ the, of: doc });
  const init = {
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [base.toString()]: {
            is: { v: 0 },
          },
        },
      },
    },
  };
  const created = {
    the,
    of: doc,
    is: { v: 0 },
    cause: base,
  };

  assert(await Repository.transact(session, init).ok);

  const updateA = {
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [space]: {
          [refer(created).toString()]: {
            is: { a: true },
          },
        },
      },
    },
  };

  const a = await Repository.transact(session, updateA);

  assertEquals(a.ok, {
    the,
    of: refer(space).toString(),
    is: {
      transaction: updateA,
      since: 1,
    },
    cause: refer({
      the,
      of: refer(space).toString(),
      is: {
        transaction: init,
        since: 0,
      },
      cause: {
        the,
        of: refer(space).toString(),
      },
    }),
  });

  const updateB = {
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [refer(created).toString()]: {
            is: { b: true },
          },
        },
      },
    },
  };

  const b = await Repository.transact(session, updateB);
  assert(b.error, "Concurrent update was rejected");
  assert(b.error.name === "ConflictError");

  assertEquals(b.error.conflict, {
    in: space,
    the: "application/json",
    of: doc,
    expected: refer(created),
    actual: {
      the: "application/json",
      of: doc,
      is: { a: true },
      cause: refer(created),
    },
  });
});

// test(
//   "concurrent identical memory creation succeed",
//   new URL(`memory:${alice}`),
//   async (session) => {
//     const result = await Repository.assert(session, {
//       the: "application/json",
//       of: doc,
//       is: { this: doc },
//     });

//     assertEquals(result, {
//       ok: {
//         the: "application/json",
//         of: doc,
//         is: { this: doc },
//         cause: refer({ the: "application/json", of: doc }),
//       },
//     });

//     const update = await Repository.assert(session, {
//       the: "application/json",
//       of: doc,
//       is: { this: doc },
//       cause: refer(result.ok),
//     });

//     assertEquals(update, {
//       ok: {
//         the: "application/json",
//         of: doc,
//         is: { this: doc },
//         cause: refer(result.ok),
//       },
//     });
//   },
// );

// test("concurrent identical memory updates succeed", new URL(`memory:${alice}`), async (session) => {
//   const seed = {
//     the: "application/json",
//     of: doc,
//     is: { v: 0 },
//   };

//   const v0 = {
//     ...seed,
//     cause: refer({
//       the: "application/json",
//       of: doc,
//     }),
//   };

//   assert(await Repository.assert(session, seed).ok);

//   const first = await Repository.assert(session, {
//     the: "application/json",
//     of: doc,
//     is: { v: 1 },
//     cause: refer(v0),
//   });

//   assertEquals(first, {
//     ok: {
//       the: "application/json",
//       of: doc,
//       is: { v: 1 },
//       cause: refer(v0),
//     },
//   });

//   const second = await Repository.assert(session, {
//     the: "application/json",
//     of: doc,
//     is: { v: 1 },
//     cause: refer(v0),
//   });

//   assertEquals(second, {
//     ok: {
//       the: "application/json",
//       of: doc,
//       is: { v: 1 },
//       cause: refer(v0),
//     },
//   });
// });

// test("retract implicit", new URL(`memory:${alice}`), async (session) => {
//   // @ts-expect-error - can not retract non-existing assertion.
//   const retract = await Repository.retract(session, {
//     the: "application/json",
//     of: doc,
//   });

//   assertEquals(retract, {
//     ok: {
//       the: "application/json",
//       of: doc,
//       cause: Repository.init({
//         the: "application/json",
//         of: doc,
//       }),
//     },
//   });
// });

// test("retract document", new URL(`memory:${alice}`), async (session) => {
//   const v0 = {
//     the: "application/json",
//     of: doc,
//     is: { v: 0 },
//   };
//   const create = await Repository.assert(session, v0);

//   assert(create.ok, "Document created");
//   assertEquals(await session.query({ the: "application/json", of: doc }), {
//     ok: {
//       ...v0,
//       cause: Repository.init({ the: "application/json", of: doc }),
//     },
//   });

//   const drop = session.transact({
//     retract: {
//       the: "application/json",
//       of: doc,
//       is: { v: 0 },
//       cause: Repository.init({
//         the: "application/json",
//         of: doc,
//       }),
//     },
//   });

//   assert(drop.ok, "Document retracted");

//   assertEquals(drop, {
//     ok: {
//       the: "application/json",
//       of: doc,
//       cause: refer(create.ok),
//     },
//   });

//   const read = await session.query({ the: "application/json", of: doc });
//   assertEquals(
//     read,
//     {
//       ok: {
//         the: "application/json",
//         of: doc,
//         cause: refer(create.ok),
//       },
//     },
//     "once retracted `is` no longer included",
//   );
// });

// test(
//   "fails to retract if expected version is out of date",
//   new URL(`memory:${alice}`),
//   async (session) => {
//     const base = {
//       the: "application/json",
//       of: doc,
//       is: { v: 0 },
//     };

//     const v0 = {
//       ...base,
//       cause: Repository.init(base),
//     };

//     const v1 = {
//       the: "application/json",
//       of: doc,
//       is: { v: 1 },
//       cause: refer(v0),
//     };

//     const v2 = {
//       the: "application/json",
//       of: doc,
//       is: { v: 2 },
//       cause: refer(v1),
//     };

//     assert(await Repository.assert(session, v0).ok);
//     assert(await Repository.assert(session, v1).ok);
//     assert(await Repository.assert(session, v2).ok);

//     const result = session.transact({ retract: v1 });

//     assert(result.error, "Retract fails if expected version is out of date");
//     assert(result.error.name === "ConflictError");
//     assertEquals(result.error.conflict, {
//       in: alice,
//       the: "application/json",
//       of: doc,
//       expected: refer(v1),
//       actual: v2,
//     });

//     assertMatch(
//       result.error.message,
//       RegExp(
//         `The application/json of ${doc} in ${alice} was expected to be ${refer(
//           v1,
//         )}, but it is ${refer(v2)}`,
//       ),
//     );
//   },
// );

// test("new memory creation fails after retraction", new URL(`memory:${alice}`), async (session) => {
//   const v0 = {
//     the: "application/json",
//     of: doc,
//     is: { v: 0 },
//   };
//   const create = await Repository.assert(session, v0);

//   assert(create.ok, "Document created");

//   const retract = Repository.retract(session, create.ok);
//   assert(retract.ok, "Document retracted");

//   const conflict = await Repository.assert(session, {
//     the: "application/json",
//     of: doc,
//     is: { v: 1 },
//   });

//   assert(conflict.error, "Create fails if cause not specified");
//   assert(conflict.error.name === "ConflictError");
//   assertEquals(conflict.error.conflict, {
//     in: alice,
//     the: "application/json",
//     of: doc,
//     expected: null,
//     actual: {
//       the: "application/json",
//       of: doc,
//       cause: refer(create.ok),
//     },
//   });
// });

// Deno.test("fail to connect to non-existing replica", async () => {
//   const url = new URL(`./${alice}.sqlite`, await createTemporaryDirectory());
//   const session = await Repository.connect({ url });

//   await assert(session.error, "Replica does not exist");

//   if (session.error) {
//     assertEquals(session.error.name, "ConnectionError");
//     assertEquals(session.error.address, url.href);
//   }
// });

// Deno.test("open creates replica if does not exists", async () => {
//   const url = new URL(`./${alice}.sqlite`, await createTemporaryDirectory());

//   try {
//     const open = await Repository.open({
//       url,
//     });

//     await assert(open.ok, "Opened a repository");

//     const session = open.ok as Repository.Store;
//     const create = await Repository.assert(session, {
//       the: "application/json",
//       of: doc,
//       is: { v: 0 },
//     });

//     assertEquals(
//       create,
//       {
//         ok: {
//           the: "application/json",
//           of: doc,
//           is: { v: 0 },
//           cause: refer({ the: "application/json", of: doc }),
//         },
//       },
//       "created document",
//     );

//     const select = Repository.query(session, {
//       the: "application/json",
//       of: doc,
//     });

//     assertEquals(select.ok, {
//       the: "application/json",
//       of: doc,
//       is: { v: 0 },
//       cause: refer({ the: "application/json", of: doc }),
//     });
//   } finally {
//     await Deno.remove(url);
//   }
// });
