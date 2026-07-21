import { computed, pattern, Writable } from "commonfabric";

export default pattern(() => {
  const sessionValue = new Writable.perSession("session-ready");
  const value = computed(() => sessionValue.get());
  return { value };
});
