/// <cts-enable />
import { lift, pattern } from "commontools";

interface EchoArgs {
  message: string;
}

const liftIdentity = lift((text: string) => text);

export const echoRecipe = pattern<EchoArgs>("Echo", ({ message }) => {
  const value = liftIdentity(message);
  return { message: value };
});

export default echoRecipe;
