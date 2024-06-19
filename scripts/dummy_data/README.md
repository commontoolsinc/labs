## Running

Follow the instructions on https://simonwillison.net/2024/Jun/17/cli-language-models/ to install the llm tool and configure for Claude use.

Specifically:

```
brew install llm
llm install llm-claude-3
llm keys set claude
```

You can then generate outputs from a prompt via: `python3 generate.py prompts/backstory.txt`

### Design

A generate.py that is passed a prompt (a filename) to execute.

The prompt is executed by using `llm` under the covers and then puts the output in a folder like this: `./out/${base_filename}/DATESTRING.txt`

Prompts can also have named references, like `${name}` that need to be expanded before the prompt can be executed.

The rules of a reference like `${name}` is, in priority order:
- An input to generate.py that sets name=VAL
- A file in `golden/` that has a filname like `$name.*`
- A file in `out/$name/`, the named directory that is most recent, its `result.txt`
- A file in `prompts/` that has a filename like `$name.*`

This order means that prompt output will be used if they exist, otherwise the raw, unexecuted prompt. It also means that if you like a given output, you can pin it easily to be used in the future instead of the most recent output.

This process is recursive. When a name is found it is printed out which version it uses.

In the future, the name reference can define whether it wants the output to be executed by running through to llm.

A `generate_multi.sh` that does the same thing as it does today, to allow running multiple items.

### TODO
- Allow specifying named replacements of output
- Allow specifying named replacements of prompts
- Allow specifying golden replacements
- Allow passing named parameters at command line for replacements
- Make generate_multi use generate.py under the covers
- Figure out a way to allow transcludes of raw prompt text without executing them
- Figure out a way to allow prompts to run a for each on output from a file