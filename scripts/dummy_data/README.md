## Running

Follow the instructions on https://simonwillison.net/2024/Jun/17/cli-language-models/ to install the llm tool and configure for Claude use.

Specifically:

```
brew install llm
llm install llm-claude-3
llm keys set claude
```

The run: `./generate.sh` . This will blow away anything currently in `out/` and overwrite it.