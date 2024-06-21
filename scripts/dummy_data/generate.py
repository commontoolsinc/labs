import sys
import os
import subprocess
import re
import argparse
import itertools
from datetime import datetime
from typing import List, Dict, Optional, TypeAlias, Union, Tuple, cast, Literal, TypedDict, get_args

from dataclasses import dataclass

GOLDEN_DIR = 'golden'
INCLUDES_DIR = 'includes'
PROMPTS_DIR = 'prompts'
TARGET_DIR = 'target'
LATEST_LINK = '_latest'
INFO_DIR = '_info'
WILDCARD = '*'

OverridesDict: TypeAlias = Dict[str, str]
PlaceholderValue : TypeAlias = Union[str, Dict[str, str]]

# When adding a value, also change IgnoreDict.
IgnoreType = Literal['golden', 'target', 'includes', 'prompts', 'overrides']
class IgnoreDict(TypedDict, total=False):
    golden: List[str]
    target: List[str]
    includes: List[str]
    prompts: List[str]
    overrides: List[str]

@dataclass
class ExecutionContext:
    overrides: Dict[str, str]
    timestamp: str
    # an array of names, which must be 'golden', 'target', 'includes', or 'prompts'
    ignore: IgnoreDict

# returns all the variations, as well as the keys that varied. as well as a map from value to shortname
def value_variations(input : Dict[str, PlaceholderValue]) -> Tuple[List[Dict[str, str]], List[str], Dict[str, str]] :
    variations : List[Dict[str, str]] = []
    nested_keys = [k for k, v in input.items() if isinstance(v, dict)]
    
    if not nested_keys:
        return (cast(List[Dict[str, str]],[input.copy()]), [], {})

    nested_values: List[List[Tuple[str, str, str]]] = [[(k, vk, vv) for vk, vv in input[k].items()] for k in nested_keys] # type: ignore
    
    short_names : Dict[str, str] = {}

    for combination in itertools.product(*nested_values):
        variation = {k: v for k, v in input.items() if not isinstance(v, dict)}
        for orig_key, nested_key, nested_value in combination: # type: ignore
            variation[orig_key] = nested_value
            short_names[nested_value] = nested_key
        variations.append(variation)
    
    return (variations, nested_keys, short_names)
        
def name_for_variation(variation : Dict[str, str], nested_keys : List[str], short_names : Dict[str, str]) -> str:
    result : List[str] = []
    for k, v in variation.items():
        if k not in nested_keys:
            continue
        short = short_names.get(v, v)
        str_v = sanitize_string(f"{short}")
        if len(str_v) > 32:
            #create a md5 hash of the string and render it in a positive hex number
            str_v = f"{hash(v) & 0xFFFFFFFF:08x}"
        result.append(str_v)
    return "_".join(result)

def fetch_most_recent_target(name: str) -> Optional[PlaceholderValue]:
    return fetch_folder(f"./{TARGET_DIR}/{name}/{LATEST_LINK}", name, True)

def fetch_folder(folder : str, name: str, folder_is_specific : bool = False) -> Optional[PlaceholderValue]:
    # check the folder exists
    if not os.path.exists(folder):
        return None

    # Looks for the file in ${folder}/ with the basename ${name} (any extension) and returns the contents
    files = [f for f in os.listdir(folder) if os.path.isfile(os.path.join(folder, f))]
    for file in files:
        if os.path.splitext(file)[0] == name:
            with open(f"{folder}/{file}", 'r') as file:
                return file.read()

    filename = os.path.join(folder, name) if not folder_is_specific else folder

    # if the filename is a directory:
    if os.path.isdir(filename):
        # return the contents of each file in the directory. By skipping directories, we naturally skip INFO_DIR
        files = [f for f in os.listdir(filename) if os.path.isfile(os.path.join(filename, f))]
        result : Dict[str, str] = {}
        for file in files:
            with open(f"{filename}/{file}", 'r') as file_obj:
                # remove the extension from the filename
                result[os.path.splitext(file)[0]] = file_obj.read()
        return result
    
    return None

def fetch_prompt(name: str, context : ExecutionContext, parent_names: List[str]) -> Optional[PlaceholderValue]:
    # Fetch the raw prompt and compile it
    raw_prompt = fetch_folder(PROMPTS_DIR, name)

    if not raw_prompt:
        return None
    
    print(f"Executing prompt for {name}...")

    if isinstance(raw_prompt, dict):
        # TODO: figure out how to support this
        raise Exception(f"Nested multi not supported for {name}")

    execute_prompt(name, raw_prompt, context, parent_names)

    return fetch_most_recent_target(name)

def should_ignore(folder : IgnoreType, name: str, ignore: IgnoreDict) -> bool:
    if folder not in ignore:
        return False
    
    l = ignore.get(folder, [])

    if WILDCARD in l:
        return True

    return name in l

def fetch_placeholder(name: str, context : ExecutionContext, parent_names: List[str]) -> PlaceholderValue:

    # Override order:
    # 1. Explicitly provided placeholder_override
    # 2. A matching output file from golden/
    # 3. Most recent target output
    # 4. A matching file from `includes/`
    # 5. A matching file from `prompts/` (which will be compiled and executed)

    if name in context.overrides:
        if should_ignore('overrides', name, context.ignore):
            print(f"Would have used placeholder override for {name} but --ignore overrides was specified.")
        else: 
            print(f"Using placeholder override for {name}...")
            return context.overrides[name]

    value = fetch_folder(GOLDEN_DIR, name)
    if value:
        if should_ignore('golden', name, context.ignore):
            print(f"Would have used golden file for {name} but --ignore golden was specified.")
        else:
            print(f"Using golden file for {name}...")
            return value

    value = fetch_most_recent_target(name)
    if value:
        if should_ignore('target', name, context.ignore):
            print(f"Would have used most recent target for {name} but --ignore target was specified.")
        else:
            print(f"Using most recent target for {name}...")
            return value
    
    value = fetch_folder(INCLUDES_DIR, name)
    if value:
        if should_ignore('includes', name, context.ignore):
            print(f"Would have used include file for {name} but --ignore includes was specified.")
        else:
            print(f"Using include file for {name}...")
            return value

    value = fetch_prompt(name, context, parent_names)
    if value:
        if should_ignore('prompts', name, context.ignore):
            # TODO: isn't it weird that even if we were told to ignore prompts we still execute them?
            print(f"Would have used prompt file for {name} but --ignore prompts was specified.")
        else: 
            # TODO: if this had to be compiled, this message comes after the compilation.
            print(f"Using prompt file for {name}...")
            return value

    raise Exception(f"Could not find value for placeholder {name}")

def compile_prompt(name: str, raw_prompt: str, context : ExecutionContext, parent_names: List[str]) -> PlaceholderValue:

    # Identify any placeholders in the prompt that match ${name}, ignoring any whitespace in the placeholder
    placeholders = re.findall(r"\${\s*([a-zA-Z0-9_:]+)\s*}", raw_prompt)

    if len(placeholders) == 0:
        if len(parent_names) == 0:
            # Don't bother printing this message if we're in a recursive call
            print("No placeholders found in the prompt.")
        return raw_prompt
    
    print(f"Compiling prompt for {name}...")

    # create a dictionary to store the values of the placeholders
    placeholder_values: Dict[str, PlaceholderValue] = {}

    # Iterate over the placeholders
    for raw_placeholder in placeholders:

        # split at the colon to get the placeholder name and the format
        placeholder_parts = raw_placeholder.split(":")
        placeholder = placeholder_parts[0].strip()

        multi = False

        if len(placeholder_parts) > 1:
            command = placeholder_parts[1].strip()
            if command == "multi":
                multi = True
            else:
                raise Exception(f"Invalid command {command} in placeholder {raw_placeholder}")

        if placeholder in parent_names:
            raise Exception(f"Circular dependency detected: {parent_names} -> {placeholder}")
        
        # check that placeholder matches [a-zA-Z][a-zA-Z0-9_]*
        if not re.match(r"^[_a-zA-Z][a-zA-Z0-9_]*$", placeholder):
            raise Exception(f"Invalid placeholder name {placeholder}")

        print(f"Getting value for {placeholder}...")
        # Store the value in the dictionary
        value = fetch_placeholder(placeholder, context, parent_names + [name])
        if multi and isinstance(value, str):
            new_value = {}
            for line in value.splitlines():
                if line:
                    new_value[line] = line
            value = new_value

        if isinstance(value, dict):
            result : Dict[str, str] = {}
            for key, val in value.items():
                temp = compile_prompt(placeholder, val, context, parent_names + [name])
                if isinstance(temp, dict):
                    # TODO: figure out how to support this case
                    raise Exception(f"Nested multi not supported for {placeholder}")
                result[key] = temp
            placeholder_values[placeholder] = result
        else:
            placeholder_values[placeholder] = compile_prompt(placeholder, value, context, parent_names + [name])

    result : Dict[str, str] = {}

    (variations, nested_keys, short_names) = value_variations(placeholder_values)

    # Iterate over every combination of placeholder values. If there are no
    # multi values, this will run once. If there are multiple multi values with
    # length m and n, this will run m * n times. And so on.
    for variation in variations:
        # Replace the placeholders with the values
        prompt = raw_prompt
        for placeholder, value in variation.items():
            # we can't do a naive match because the placeholder tag might
            # include other commands. e.g. the placeholder "input" might need to
            # match "${input:multi}"
            pattern = re.compile(rf'\${{{re.escape(placeholder)}(?::[^}}]*)?}}')
            escaped_value = escape_backslashes(value)
            prompt = pattern.sub(escaped_value, prompt)
        variation_name = name_for_variation(variation, nested_keys, short_names)
        result[variation_name] = prompt

    # if it's a single prompt, return the only value.        
    keys = list(result.keys())
    if len(keys) == 1:
        return result[keys[0]]

    # Return the compiled prompt
    return result


def execute_prompt(name: str, raw_prompt: str, context : ExecutionContext, parent_names: Optional[List[str]] = None) -> None:

    if parent_names is None:
        parent_names = []

    timestamp = context.timestamp

    # Generate the output directory path
    output_dir = f"./target/{name}/{timestamp}"
    prompts_dir = os.path.join(output_dir, INFO_DIR, PROMPTS_DIR)
    # This will also make the output_dir implicitly
    os.makedirs(prompts_dir, exist_ok=True)

    # Compile the prompt
    prompt = compile_prompt(name, raw_prompt, context, parent_names)
    
    if isinstance(prompt, str):
        new_prompt = {}
        new_prompt[name] = prompt
        prompt = new_prompt

    for variation_name, prompt in prompt.items():
        try:
            # TODO: don't double print names in single mode
            print(f"Running llm command for {name} / {variation_name}...")

            # Pipe the prompt contents to the llm command with the option -m claude-3.5-sonnet
            output = subprocess.check_output(['llm', '-m', 'claude-3.5-sonnet'], input=prompt, universal_newlines=True)

            # Generate the output file path
            output_file = f"{output_dir}/{variation_name}.txt"

            # Save the output to the file
            with open(output_file, 'w') as file:
                file.write(output)

            prompt_output_file = f"{prompts_dir}/{variation_name}.txt"
            with open(prompt_output_file, 'w') as file:
                file.write(prompt)

            print(f"Output saved to {output_file}")

        except subprocess.CalledProcessError as e:
            print(f"Error running llm command for {name}: {e}")
            sys.exit(1)

    # Create the soft link '_latest' pointing to the timestamp directory
    # We wait until here, so that we don't create a pointer to an incomplete run
    latest_link = f"./target/{name}/{LATEST_LINK}"
    if os.path.exists(latest_link):
        os.unlink(latest_link)
    os.symlink(timestamp, latest_link, target_is_directory=True)

def sanitize_string(input_string : str) -> str:
    return re.sub(r'[^a-zA-Z0-9_-]', '_', input_string)

def escape_backslashes(s : str) -> str:
    return s.replace('\\', '\\\\')

def main() -> None:
    parser = argparse.ArgumentParser(description='Process a prompt file.\nBy default, a single prompt is executed. If stdin is provided, then it will execute the template once for each line, piping that line\'s input as the override variable "_input"')
    parser.add_argument('prompt_file', help='Path to the prompt file')
    parser.add_argument('--overrides', nargs='+', action='append', help='Named override placeholders in the format ARG_1 VAL_1 ARG_2 VAL_2')
    parser.add_argument('--ignore', nargs='+', help=f"Ignore specific types of inputs. Types include {get_args(IgnoreType)}. You can also add a ':placeholder_1,placeholder_2' to specify only those placeholders. You can also do multiple named types in front of the colon: 'golden,target:backstory'. '*' means all of that type", )

    args = parser.parse_args()

    prompt_file = args.prompt_file
    prompt_base_filename = os.path.splitext(os.path.basename(prompt_file))[0]

    overrides : OverridesDict = {}

    if args.overrides:
        # We'll populate the global placeholder_overrides dictionary with the named arguments
        for arg_pair in args.overrides:
            if len(arg_pair) % 2 != 0:
                print("Invalid named arguments. Each argument should have a corresponding value.")
                sys.exit(1)
            for i in range(0, len(arg_pair), 2):
                arg_name = arg_pair[i]
                arg_value = arg_pair[i + 1]
                overrides[arg_name] = arg_value.strip('"')

    # Read the contents of the prompt file
    with open(prompt_file, 'r') as file:
        prompt_contents = file.read()

    # Generate a timestamp, do it now so we'll use the same one in multiple runs in multi-mode.
    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")

    ignore = IgnoreDict()
    if args.ignore:
        for arg in args.ignore:
            parts = arg.split(':')
            for key in parts[0].split(','):
                key = key.strip()
                if key not in get_args(IgnoreType):
                    print(f"Invalid ignore type {key}. Valid types are {get_args(IgnoreType)}")
                    sys.exit(1)
                if len(parts) == 1:
                    ignore[key] = [WILDCARD]
                else:
                    # split and trim the placeholders
                    ignore[key] = [p.strip() for p in parts[1].split(',')]

    context = ExecutionContext(overrides, timestamp, ignore)

    execute_prompt(prompt_base_filename, prompt_contents, context)


if __name__ == '__main__':
    main()