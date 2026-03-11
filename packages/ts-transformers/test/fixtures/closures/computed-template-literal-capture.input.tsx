/// <cts-enable />
import { computed, pattern } from "commontools";

// CT-1334: computed() with template literal capturing pattern parameter.
// The `token` from pattern destructuring must be captured as an explicit
// input to the derived derive() call, so the callback receives the
// resolved value—not the OpaqueRef proxy.
export default pattern(({ token }: { token: string }) => {
  const url = computed(() => `http://api.example.com?token=${token}`);
  const options = computed(() => ({
    headers: { Authorization: `Bearer ${token}` },
  }));
  return { url, options };
});
