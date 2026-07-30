---
status: historical
created: 2026-07-30
archived: 2026-07-30
reason: "Investigation snapshot of CF harness prompt-cache behavior and usage accounting."
---

# CF harness cache and usage investigation

Equivalent-looking work in CF harness appeared to consume quota and money
faster than other agent harnesses. The harness did not expose enough provider
telemetry to determine whether the difference came from cache misses, reasoning
tokens, context growth, output volume, or provider pricing.

## Findings from the code

OpenAI prompt caching is server-side and depends on an exact shared prompt
prefix. Before this investigation, a multi-turn CF harness run naturally
retained that prefix, so the code did not obviously disable caching. It did,
however, discard cache and reasoning usage detail, omit a stable cache affinity
key, and provide no cache-mode or reasoning-effort controls. The initial
problem was therefore missing evidence, not proven cache incompatibility.

Dollar cost and subscription quota are separate measurements. Public API prices
can estimate compatible-gateway traffic when all required counters are present.
They do not convert ChatGPT/Codex subscription token telemetry into quota or an
invoice.

## Live experiment

The experiment ran on 2026-07-30 through the real CF harness, Docker 27.4.0,
the connected `openai-codex` subscription, and `gpt-5.6-terra` at low reasoning
effort. The sandbox contained only three synthetic files. Each case requested
three sequential `read_file` calls, producing four model turns.

### Case 1: below the cache threshold

Each turn remained below the provider's 1,024-token cache-eligibility
threshold:

| Turn | Input | Cached input | Output | Reasoning |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 497 | 0 | 41 | 18 |
| 2 | 648 | 0 | 40 | 14 |
| 3 | 798 | 0 | 21 | 0 |
| 4 | 929 | 0 | 22 | 0 |
| **Total** | **2,872** | **0** | **124** | **32** |

The zero-cache result did not require a compatibility failure: no request was
eligible.

### Case 2: stable prefix above the threshold

Inert synthetic padding took the first request above 1,024 input tokens:

| Turn | Input | Cached input | Output | Reasoning |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1,265 | 0 | 43 | 20 |
| 2 | 1,405 | 1,024 | 24 | 0 |
| 3 | 1,535 | 1,024 | 21 | 0 |
| 4 | 1,640 | 1,024 | 33 | 0 |
| **Total** | **5,845** | **3,072** | **121** | **20** |

The aggregate cache-read ratio was 52.6%. Every continuation received a
1,024-token cache hit. This demonstrated that CF harness was compatible with
the subscription backend's implicit prompt cache and that the new affinity and
telemetry paths worked in a real multi-turn Docker run.

The subscription response reported zero cache-write tokens and no dollar cost.
For scale only, the public GPT-5.6 Terra API schedule would put these
read/output counters at approximately $0.00952 with cache reads versus $0.01643
if every input token were uncached, about a 42% reduction. Those figures are
illustrative API equivalents, not a ChatGPT invoice or quota conversion.

### Case 3: cache-mode compatibility

A controlled Codex request with
`prompt_cache_options.mode = "implicit"` failed with HTTP 400 before model
execution. Removing only that cache-mode control while retaining low reasoning
effort succeeded. The ChatGPT/Codex backend accepted `prompt_cache_key`, but not
the compatible-gateway API's `prompt_cache_options`.

The implementation was corrected so `openai-codex` rejects explicit cache-mode
controls locally while retaining stable affinity, reasoning control, implicit
caching, and usage telemetry. Implicit/explicit mode selection and explicit
breakpoints remain compatible-gateway-only.

### Case 4: compatible-gateway explicit caching

A two-turn synthetic run used the real staging compatible gateway,
`gpt-5.6-terra`, low reasoning effort, and explicit cache mode. The stable
first-user prefix crossed the cache threshold:

| Turn | Input | Cached input | Cache write | Output | Reasoning | Estimated USD |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1,123 | 0 | 1,120 | 32 | 8 | 0.0039875 |
| 2 | 1,211 | 1,120 | 0 | 9 | 0 | 0.0006425 |
| **Total** | **2,334** | **1,120** | **1,120** | **41** | **8** | **0.0046300** |

The first turn wrote the explicit 1,120-token prefix and the continuation read
that same prefix. This confirmed end to end that the gateway accepts
`prompt_cache_options.mode`, the explicit content breakpoint, stable affinity,
and reasoning effort; emits both `cached_tokens` and `cache_write_tokens`; and
provides sufficient detail for the harness estimator.

## Conclusion

The evidence did not support broad prompt/KV-cache incompatibility. It showed
working cache hits once requests became eligible on both the subscription and
compatible-gateway paths. Remaining sources of surprising consumption that the
resulting instrumentation can measure are:

- short runs or early turns below the cache threshold;
- uncached context growth beyond the reused prefix;
- reasoning and output tokens;
- descendant-agent work;
- differences between subscription quota accounting and public API prices.

The next meaningful comparison is CF harness versus Codex CLI using the same
prompt, model, reasoning effort, tools, and number of turns.

## References

- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenAI GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model)
