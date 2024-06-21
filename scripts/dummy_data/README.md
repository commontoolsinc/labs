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

The prompt is executed by using `llm` under the covers and then puts the output in a folder like this: `./cache/${base_filename}/DATESTRING/{base_filename}.txt` . It also adds a symlink in the `./cache/${base_filename}/_latest` that is updated whenever a new item is saved in that directory.

Prompts can also have named references, like `${name}` that need to be expanded before the prompt can be executed.

The rules of a reference like `${name}` is, in priority order:
- An input to generate.py of `--overrides name val`
- A file in `golden/` that has a filname like `$name.*`
- A file in `cache/$name/`, the named directory that is most recent, its `result.txt`
- A file in `includes/` that has a filename like `$name.*`
- A file in `prompts/` that has a filename like `$name.*` which will be executed and use its result

This order means that prompt output will be used if they exist, falling back on generating new output for a prompt as a last resort. The output naming scheme also means that if you find good output you want to pin in place, you can use `cp` to move the file directly into the golden folder.

This process is recursive. When a name is found it is printed out which version it uses.

As a special case, if your include has the `:multi` directive, it says 'load up the named placeholder, and then interpet each line as a separate value and call this template once for each file'. You can see prompts/schema.txt for an example. Instead of outputting one result, it will output as many results as non-empty lines in that file, named for the lines. Later, other templates that load up that named placeholder, if they find multiple outputs (instead of one file) will also go into multi-output mode.

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
- switch ':' in multi directive to '|'
- remove the fetch_placeholder directory and just return the value (we no longer need the directory)
- If a template references the same placeholder that is a multi, only do the multi one time (this might already work). This sets us up for a use case that allows using the name or value of the multi file, so you could say: 'A file named ${schema|name} with content ${schema}' and ahve it replaced.
- Parallelize multi-generation
- Allow pinning a not-most-recent version (perhaps via an interactive UI?)