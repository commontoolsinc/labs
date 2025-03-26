import { assert, assertEquals, AssertionError, assertMatch } from "@std/assert";
import * as Provider from "../provider.ts";
import * as Consumer from "../consumer.ts";
import * as Changes from "../changes.ts";
import * as Fact from "../fact.ts";
import { refer } from "../reference.ts";

import { alice, space } from "./principal.ts";

const url = new URL(`./${space}.sqlite`, import.meta.url);

// Some generated service key.
const serviceDid = "did:key:z6MkfJPMCrTyDmurrAHPUsEjCgvcjvLtAuzyZ7nSqwZwb8KQ";

const main = async () => {
  const result = await Provider.open({
    store: url,
    serviceDid,
  });
  const provider = result.ok!;

  const consumer = Consumer.open({
    as: alice,
    session: provider.session(),
  });

  const changes = generateChanges(2000);

  Deno.writeFileSync(
    `debug.json`,
    new TextEncoder().encode(JSON.stringify({ changes }, null, 2)),
  );

  const home = consumer.mount(space.did());

  const start = Date.now();

  const transaction = await home.transact({ changes });
  console.log("end transaction", Date.now() - start);
  console.log(transaction);
};

const generateChanges = (count: number) => {
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

  return Changes.from(facts);
};

main();
