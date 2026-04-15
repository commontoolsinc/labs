import { computed, handler, pattern, Stream, Writable } from "commonfabric";
import RenderPolicyDemo, { TrustedHealthDisclosureSurface } from "./main.tsx";

const trigger = handler<void, { stream: Stream<unknown> }>((_, { stream }) => {
  stream.send(undefined);
});

export default pattern(() => {
  const demo = RenderPolicyDemo({});
  const revealSensitive = Writable.of(false);
  const trustedDisclosure = TrustedHealthDisclosureSurface({
    content: Writable.of("Sensitive health data") as never,
    revealSensitive,
  });

  const action_reveal = trigger({ stream: trustedDisclosure.reveal });
  const action_conceal = trigger({ stream: trustedDisclosure.conceal });

  const assert_initially_hidden = computed(() =>
    revealSensitive.get() === false
  );
  const assert_revealed = computed(() => revealSensitive.get() === true);
  const assert_concealed = computed(() => revealSensitive.get() === false);

  return {
    tests: [
      { assertion: assert_initially_hidden },
      { action: action_reveal },
      { assertion: assert_revealed },
      { action: action_conceal },
      { assertion: assert_concealed },
    ],
    demo,
    trustedDisclosure,
  };
});
