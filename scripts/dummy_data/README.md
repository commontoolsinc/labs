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

The prompt is executed by using `llm` under the covers and then puts the output in a folder like this: `./target/${base_filename}/DATESTRING/{base_filename}.txt`

Prompts can also have named references, like `${name}` that need to be expanded before the prompt can be executed.

The rules of a reference like `${name}` is, in priority order:
- An input to generate.py of `--overrides name val`
- A file in `golden/` that has a filname like `$name.*`
- A file in `target/$name/`, the named directory that is most recent, its `result.txt`
- A file in `includes/` that has a filename like `$name.*`
- A file in `prompts/` that has a filename like `$name.*` which will be executed and use its result

This order means that prompt output will be used if they exist, falling back on generating new output for a prompt as a last resort. The output naming scheme also means that if you find good output you want to pin in place, you can use `cp` to move the file directly into the golden folder.

This process is recursive. When a name is found it is printed out which version it uses.

If you pipe in a file to the generate.py command, then it will call the given prompt once for each non-empty line, where each invocation will set that line's values to ${_input}. In this multi-mode, the output in target will be separate files.

Example: cat target/files/2024-06-19_15-55-23/files.txt | python3 generate.py prompts/schema.txt

### TODO
- A debug mode to print out the raw prompts as returned from compile
- Create a @latest alias to the most recent run in a target output dir
- Figure out a way to allow prompts to run a for each on output from a file (so no need for a separate multi command)