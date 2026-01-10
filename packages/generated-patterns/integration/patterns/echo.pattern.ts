/// <cts-enable />
import { lift, recipe } from "commontools";

interface EchoArgs {
  message: string;
}

const liftIdentity = lift((text: string) => text);

export const echoRecipe = recipe<EchoArgs>("Echo", ({ message }) => {
  const value = liftIdentity(message);
  return { message: value };
});

export default echoRecipe;
