import { computed, handler, pattern, Stream } from "commonfabric";
import RenderPolicyDemo from "./main.tsx";

const trigger = handler<void, { stream: Stream<unknown> }>((_, { stream }) => {
  stream.send(undefined);
});

export default pattern(() => {
  const demo = RenderPolicyDemo({});

  const action_reveal = trigger({ stream: demo.reveal });
  const action_conceal = trigger({ stream: demo.conceal });

  const assert_initially_hidden = computed(() =>
    demo.revealSensitive === false
  );
  const assert_revealed = computed(() => demo.revealSensitive === true);
  const assert_concealed = computed(() => demo.revealSensitive === false);

  return {
    tests: [
      { assertion: assert_initially_hidden },
      { action: action_reveal },
      { assertion: assert_revealed },
      { action: action_conceal },
      { assertion: assert_concealed },
    ],
    demo,
  };
});
