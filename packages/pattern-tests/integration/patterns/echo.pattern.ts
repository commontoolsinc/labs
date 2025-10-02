/// <cts-enable />
import { lift, recipe } from "commontools";

interface EchoArgs {
  message: string;
}

export const echoRecipe = recipe<EchoArgs>("Echo", ({ message }) => {
  const value = lift((text: string) => text)(message);
  return { message: value };
});
