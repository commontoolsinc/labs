import sys
import os
import subprocess
import re
import argparse
import itertools
from datetime import datetime
from typing import List, Dict, Optional, TypeAlias, Union, Tuple, cast

GOLDEN_DIR = 'golden'
INCLUDES_DIR = 'includes'
PROMPTS_DIR = 'prompts'
TARGET_DIR = 'target'
LATEST_LINK = '_latest'

OverridesDict: TypeAlias = Dict[str, str]
PlaceholderValue : TypeAlias = Union[str, Dict[str, str]]

# returns all the variations, as well as the keys that varied.
def value_variations(input : Dict[str, PlaceholderValue]) -> Tuple[List[Dict[str, str]], List[str]] :
    variations : List[Dict[str, str]] = []
    nested_keys = [k for k, v in input.items() if isinstance(v, dict)]
    
    if not nested_keys:
        return (cast(List[Dict[str, str]],[input.copy()]), [])

    nested_values: List[List[Tuple[str, str, str]]] = [[(k, vk, vv) for vk, vv in input[k].items()] for k in nested_keys] # type: ignore
    
    for combination in itertools.product(*nested_values):
        variation = {k: v for k, v in input.items() if not isinstance(v, dict)}
        for orig_key, nested_key, nested_value in combination: # type: ignore
            variation[orig_key] = nested_key
        variations.append(variation)
    
    return (variations, nested_keys)
        
def name_for_variation(variation : Dict[str, str], nested_keys : List[str]) -> str:
    return "_".join([f"{v}" for k, v in variation.items() if k in nested_keys])

def fetch_most_recent_target(name: str) -> Optional[PlaceholderValue]:
    return fetch_folder(f"./{TARGET_DIR}/{name}/{LATEST_LINK}", name)

def fetch_folder(folder : str, name: str) -> Optional[PlaceholderValue]:
    # check the folder exists
    if not os.path.exists(folder):
        return None

    # Looks for the file in ${folder}/ with the basename ${name} (any extension) and returns the contents
    files = [f for f in os.listdir(folder) if os.path.isfile(os.path.join(folder, f))]
    for file in files:
        if os.path.splitext(file)[0] == name:
            with open(f"{folder}/{file}", 'r') as file:
                return file.read()
    
    return None

def fetch_prompt(name: str, timestamp : str, overrides : OverridesDict, parent_names: List[str]) -> Optional[PlaceholderValue]:
    # Fetch the raw prompt and compile it
    raw_prompt = fetch_folder(PROMPTS_DIR, name)

    if not raw_prompt:
        return None
    
    print(f"Executing prompt for {name}...")

    if isinstance(raw_prompt, dict):
        # TODO: figure out how to support this
        raise Exception(f"Nested multi not supported for {name}")

    execute_prompt(name, raw_prompt, timestamp, overrides, parent_names)

    return fetch_most_recent_target(name)

# Returns a tuple of the placeholder, and the directory it was found in
def fetch_placeholder(name: str, timestamp : str, overrides: OverridesDict, parent_names: List[str]) -> Tuple[PlaceholderValue, str]:

    # Override order:
    # 1. Explicitly provided placeholder_override
    # 2. A matching output file from golden/
    # 3. Most recent target output
    # 4. A matching file from `includes/`
    # 5. A matching file from `prompts/` (which will be compiled and executed)

    if name in overrides:
        print(f"Using placeholder override for {name}...")
        return (overrides[name], "")

    value = fetch_folder(GOLDEN_DIR, name)
    if value:
        print(f"Using golden file for {name}...")
        return (value, GOLDEN_DIR)

    value = fetch_most_recent_target(name)
    if value:
        print(f"Using most recent target for {name}...")
        return (value, f"./{TARGET_DIR}/{name}/{LATEST_LINK}")
    
    value = fetch_folder(INCLUDES_DIR, name)
    if value:
        print(f"Using include file for {name}...")
        return (value, INCLUDES_DIR)

    value = fetch_prompt(name, timestamp, overrides, parent_names)
    if value:
        # TODO: if this had to be compiled, this message comes after the compilation.
        print(f"Using prompt file for {name}...")
        return (value, f"./{TARGET_DIR}/{name}/{LATEST_LINK}")

    raise Exception(f"Could not find value for placeholder {name}")

def compile_prompt(name: str, raw_prompt: str, timestamp : str, overrides : OverridesDict, parent_names: List[str]) -> PlaceholderValue:

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
        (value, directory) = fetch_placeholder(placeholder, timestamp, overrides, parent_names + [name])
        if multi and isinstance(value, str):
            new_value = {}
            for line in value.splitlines():
                if line:
                    content = ''
                    filename = os.path.join(directory, line)
                    # if the line is a valid filename, read the file contents
                    if os.path.exists(filename):
                        with open(filename, 'r') as file:
                            content = file.read()
                    key = line
                    new_value[key] = content
            value = new_value

        if isinstance(value, dict):
            result : Dict[str, str] = {}
            for key, val in value.items():
                temp = compile_prompt(placeholder, val, timestamp, overrides, parent_names + [name])
                if isinstance(temp, dict):
                    # TODO: figure out how to support this case
                    raise Exception(f"Nested multi not supported for {placeholder}")
                result[key] = temp
            placeholder_values[placeholder] = result
        else:
            placeholder_values[placeholder] = compile_prompt(placeholder, value, timestamp, overrides, parent_names + [name])

    result : Dict[str, str] = {}

    (variations, nested_keys) = value_variations(placeholder_values)

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
            prompt = pattern.sub(value, prompt)
        variation_name = name_for_variation(variation, nested_keys)
        result[variation_name] = prompt

    # if it's a single prompt, return the only value.        
    keys = list(result.keys())
    if len(keys) == 1:
        return result[keys[0]]

    # Return the compiled prompt
    return result


def execute_prompt(name: str, raw_prompt: str, timestamp : str, overrides: OverridesDict, parent_names: Optional[List[str]] = None) -> None:

    if parent_names is None:
        parent_names = []

    # Generate the output directory path
    output_dir = f"./target/{name}/{timestamp}"
    os.makedirs(output_dir, exist_ok=True)

    # Create the soft link '_latest' pointing to the timestamp directory
    latest_link = f"./target/{name}/{LATEST_LINK}"
    if os.path.exists(latest_link):
        os.unlink(latest_link)
    os.symlink(timestamp, latest_link, target_is_directory=True)

    # Compile the prompt
    prompt = compile_prompt(name, raw_prompt, timestamp, overrides, parent_names)
    
    if isinstance(prompt, str):
        new_prompt = {}
        new_prompt[name] = prompt
        prompt = new_prompt

    for variation_name, prompt in prompt.items():
        try:
            # TODO: don't double print names in single mode
            print(f"Running llm command for {name} / {variation_name}...")

            # Pipe the prompt contents to the llm command
            output = subprocess.check_output(['llm'], input=prompt, universal_newlines=True)

            # Generate the output file path
            output_file = f"{output_dir}/{variation_name}.txt"

            # Save the output to the file
            with open(output_file, 'w') as file:
                file.write(output)

            prompt_output_file = f"{output_dir}/_prompt_{variation_name}.txt"
            with open(prompt_output_file, 'w') as file:
                file.write(prompt)

            print(f"Output saved to {output_file}")

        except subprocess.CalledProcessError as e:
            print(f"Error running llm command for {name}: {e}")
            sys.exit(1)

def sanitize_string(input_string : str) -> str:
    return re.sub(r'[^a-zA-Z0-9_-]', '_', input_string)

def main() -> None:
    parser = argparse.ArgumentParser(description='Process a prompt file.\nBy default, a single prompt is executed. If stdin is provided, then it will execute the template once for each line, piping that line\'s input as the override variable "_input"')
    parser.add_argument('prompt_file', help='Path to the prompt file')
    parser.add_argument('--overrides', nargs='+', action='append', help='Named override placeholders in the format ARG_1 VAL_1 ARG_2 VAL_2')

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

    execute_prompt(prompt_base_filename, prompt_contents, timestamp, overrides)


if __name__ == '__main__':
    main()