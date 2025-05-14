import { Identity } from "@commontools/identity";

const OPERATOR_PASS = Deno.env.get("OPERATOR_PASS") ?? "common user";

export const name2did = async (name: string) => {
  const account = await Identity.fromPassphrase(OPERATOR_PASS);
  const space = await account.derive(name);
  console.log(" NAME:", name);
  console.log("SPACE:", space.did());
};

const args = Deno.args;

if (args.length < 1) {
  console.error("Error: Please provide a name argument.");
  console.log("Usage: deno task name2did <name>");
  Deno.exit(1);
}

await name2did(args[0]);
Deno.exit(0);
