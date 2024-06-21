## Running

Follow the instructions on https://simonwillison.net/2024/Jun/17/cli-language-models/ to install the llm tool and configure for Claude use.

Specifically:

```
brew install llm
llm install llm-claude-3
llm keys set claude
```

You can then generate outputs from a prompt via: `python3 generate.py prompts/backstory.txt`

## Basic usage

A generate.py that is passed a prompt (a filename) to execute.

The prompt is executed by using `llm` under the covers and then puts the output in a folder like this: `./cache/${base_filename}/DATESTRING/{base_filename}.txt` . It also adds a symlink in the `./cache/${base_filename}/_latest` that is updated whenever a new item is saved in that directory.

Prompts can also have named references, like `${name}` that need to be expanded before the prompt can be executed.

The rules of a reference like `${name}` is, in priority order:
- An input to generate.py of `--overrides name val`
- A file in `golden/` that has a filname like `$name.*`
- A file in `cache/$name/`, the named directory that is most recent, its `result.txt`
- A file in `includes/` that has a filename like `$name.*`
- A file in `prompts/` that has a filename like `$name.*` which will be executed and use its result

This order means that prompt output will be used if they exist, falling back on generating new output for a prompt as a last resort. The output naming scheme also means that if you find good output you want to pin in place, you can use `cp` to move the file directly into the golden folder. You can also use `pin_golden.py` (see below)

This process is recursive. When a name is found it is printed out which version it uses.

## Multi-Mode

Most placeholders are a single reference to a single value. However, it's also possible to go into multi-mode, which operates on multiple placeholders in parallel.

This happens if you read a placeholder that was in multi-mode (which puts your result in multi-mode), or if you use a special operator on the placeholder reference to put it into multi mode.

The main way to put a placeholder into multi mode is to use the `split` directive in your prompt, like this: `Here is the schema: ${schema|split}`. This will load up the value at schema according to the rules, and then split it so the prompt is run once per non-empty line in the schema input. The output for each line will be named on the content of that line. Downstream templates that rely on that output will be in multi-mode by default.

You can also take a multi-mode placeholder and join it into a single placeholder with `join`: `Here is the schema: ${schema|join}`. Join can join the names of the items, or the content (default). You can choose one or the other with an argument like: `${schema|join:name}`, or `${schema|join:both}` to do the name, a newline, and the value. See `prompts/joined_schema.txt` for an example.

## Caching

If you want to override which placeholder to use, you can pass the `--ignore` flag. The legal classes of cached values to ignore: 'golden', 'cache', 'includes', 'overrides'. All of the following are valid:
- `cache` - ignores all pre-computed targets for all placeholders
- `cache:*` - the same semantics as the line above
- `cache:files` - ignores the pre-computed target for the placeholder named files
- `cache:files,backstory` - ignore the pre-computed target for the placeholders named files and backstory
- `cache,golden:files,backstory` - ignore the pre-computed target and the golden for the placeholders named files and backstory.
- `existing` - equivalent to 'golden,cache,prompts:*'

## pin_golden.py

It's possible to manually copy over goldens you like. There's also a simple command, `pin_golden.py` that takes a space-delimited list of placeholder names, and then copies over the most recent result from `cache` into the appropriate place in `golden`, overwriting anything that was already there.

Example: `python3 pin_golden.py schema`

### TODO
- Figure out a way to allow prompts to run a for each on output from a file (so no need for a separate multi command)
- Allow a way to specify `{files|multi-load:schema}
- Parallelize multi-generation
- Allow pinning a not-most-recent version (perhaps via an interactive UI?)
- What happens if you add the multi modifier on a value type that is already in multi-mode? Does it work?