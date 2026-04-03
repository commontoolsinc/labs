/// <cts-enable />
import { lift, pattern } from "commontools";

interface EchoArgs {
  message: string;
}

const liftIdentity = lift((text: string) => text);

export const echoPattern = pattern<EchoArgs>(({ message }) => {
  const value = liftIdentity(message);
  return { message: value };
});

export default echoPattern;
