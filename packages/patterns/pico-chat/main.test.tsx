import { action, computed, pattern } from "commonfabric";
import PicoChat from "./main.tsx";

export default pattern(() => {
  const subject = PicoChat({
    messages: [],
    name: "Alex",
  });
  const emptyNameSubject = PicoChat({
    messages: [],
    name: "",
  });
  const emptyBodySubject = PicoChat({
    messages: [],
    name: "Mary",
  });

  const action_send_message = action(() => {
    subject.send.send({ detail: { message: "Hello" } });
  });
  const action_send_without_name = action(() => {
    emptyNameSubject.send.send({ detail: { message: "Hello" } });
  });
  const action_send_without_body = action(() => {
    emptyBodySubject.send.send({ detail: { message: "   " } });
  });

  const assert_starts_empty = computed(() => subject.messages.length === 0);
  const assert_sent_message = computed(() => subject.messages.length === 1);
  const assert_empty_name_does_not_send = computed(() =>
    emptyNameSubject.messages.length === 0
  );
  const assert_empty_body_does_not_send = computed(() =>
    emptyBodySubject.messages.length === 0
  );

  return {
    tests: [
      { assertion: assert_starts_empty },
      { action: action_send_message },
      { assertion: assert_sent_message },
      { action: action_send_without_name },
      { assertion: assert_empty_name_does_not_send },
      { action: action_send_without_body },
      { assertion: assert_empty_body_does_not_send },
    ],
    subject,
    emptyNameSubject,
    emptyBodySubject,
  };
});
