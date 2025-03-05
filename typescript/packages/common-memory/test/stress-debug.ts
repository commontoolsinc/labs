import {
  assert,
  assertEquals,
  AssertionError,
  assertMatch,
} from "@std/assert";
import * as Provider from "../provider.ts";
import * as Transaction from "../transaction.ts";
import * as Changes from "../changes.ts";
import * as Fact from "../fact.ts";
import { refer } from "../reference.ts";

const space = "did:key:z6MkffDZCkCTWreg8868fG1FGFogcJj5X6PY93pPcWDn9bob";
const url = new URL(`./${space}.sqlite`, import.meta.url);

const main = async () => {
  const result = await Provider.open({ store: url });
  const provider = result.ok!;

  const tr = generateTransaction(2000);

  Deno.writeFileSync(
    `debug.json`,
    new TextEncoder().encode(JSON.stringify(tr, null, 2)),
  );

  const start = Date.now();
  const transaction = await provider.transact(tr as Provider.Transaction);
  console.log("end transaction", Date.now() - start);
  console.log(transaction);
};

const generateTransaction = (count: number) => {
  const events = Array.from({ length: count }, (_, i) => ({
    title: `Event ${i}`,
    description: `Description ${i}`,
    start: Date.now() + i * 1000 * 60 * 60 * 24,
    end: Date.now() + i * 1000 * 60 * 60 * 24 + 1000 * 60 * 60 * 2,
  }));

  const assertions = events.map((event) =>
    Fact.assert({
      the: "application/json",
      of: `of:${refer(event)}`,
      is: {
        value: event,
        source: {
          "/": "baedreib3eqm4usqyhc7cukeapc7ftzjkly672cd7u3fvr7b364urlwiugy",
        },
      },
    })
  );

  const facts = [
    Fact.assert({
      the: "application/json",
      of: `of:${refer([])}`,
      is: {
        value: {
          $TYPE: "ba4jcbly2nqee4u4o76t4sp7p3phtnblzcjjf3dulyzcrav7ios2w3swv",
          arguments: {
            count: 200,
            events: assertions.map((fact) => {
              return {
                cell: refer(fact).toJSON(),
                path: [],
              };
            }),
            internal: {
              "__#0": {
                $stream: true,
              },
              sync: {
                $stream: true,
              },
              "__#2": {
                $stream: true,
              },
              "__#1": {
                cell: {
                  "/":
                    "baedreialhcm4rsjrz577nvlvm45qmzxsywy346deacjgpqzd6vf4c43mue",
                },
                path: [],
              },
            },
            resultRef: {
              cell: {
                "/":
                  "baedreieqaqfy4ojtvoosntfm62ezhf4kwtzdsnr3h24oqgfwydxnnzzo5i",
              },
              path: [],
            },
          },
        },
      },
    }),
    ...assertions,
  ];

  return Transaction.create({
    issuer: "did:key:z6Mkge3xkXc4ksLsf8CtRxunUxcX6dByT4QdWCVEHbUJ8YVn",
    subject: "did:key:z6Mkge3xkXc4ksLsf8CtRxunUxcX6dByT4QdWCVEHbUJ8YVn",
    changes: Changes.from(facts),
  });
};

main();
