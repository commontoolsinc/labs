import sys
import os
import subprocess
import re
import argparse
from datetime import datetime
from typing import List, Dict, Optional, TypeAlias

INPUT_OVERRIDE_NAME = '_input'
INPUT_CONTENTS_OVERRIDE_NAME = '_input_contents'

GOLDEN_DIR = 'golden'
INCLUDES_DIR = 'includes'
PROMPTS_DIR = 'prompts'

SPECIAL_PLACEHOLDERS = [INPUT_OVERRIDE_NAME, INPUT_CONTENTS_OVERRIDE_NAME]

OverridesDict: TypeAlias = Dict[str, str]
PlaceholderValue : TypeAlias = str

def fetch_most_recent_target(name: str) -> Optional[PlaceholderValue]:
    # looks for the file with the most recent name in /target/${name}/ and returns the contents
    if not os.path.exists(f"./target/{name}"):
        return None

    files = os.listdir(f"./target/{name}")
    if len(files) == 0:
        return None
    files.sort(reverse=True)
    most_recent_directory = files[0]

    # TODO: better error message if you try to include a target that was output in multi-mode (where there isn't a single output but multiple)
    with open(f"./target/{name}/{most_recent_directory}/{name}.txt", 'r') as file:
        return file.read()

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
    execute_prompt(name, None, raw_prompt, timestamp, overrides, parent_names)

    return fetch_most_recent_target(name)


def fetch_placeholder(name: str, timestamp : str, overrides: OverridesDict, parent_names: List[str]) -> PlaceholderValue:

    # Override order:
    # 1. Explicitly provided placeholder_override
    # 2. A matching output file from golden/
    # 3. Most recent target output
    # 4. A matching file from `includes/`
    # 5. A matching file from `prompts/` (which will be compiled and executed)

    if name in overrides:
        print(f"Using placeholder override for {name}...")
        return overrides[name]

    value = fetch_folder(GOLDEN_DIR, name)
    if value:
        print(f"Using golden file for {name}...")
        return value

    value = fetch_most_recent_target(name)
    if value:
        print(f"Using most recent target for {name}...")
        return value
    
    value = fetch_folder(INCLUDES_DIR, name)
    if value:
        print(f"Using include file for {name}...")
        return value

    value = fetch_prompt(name, timestamp, overrides, parent_names)
    if value:
        # TODO: if this had to be compiled, this message comes after the compilation.
        print(f"Using prompt file for {name}...")
        return value
        
    if name is INPUT_OVERRIDE_NAME:
        print("The _input placeholder only works in multi-line mode. Try piping lines of input into the script.")
    
    raise Exception(f"Could not find value for placeholder {name}")

def compile_prompt(name: str, raw_prompt: str, timestamp : str, overrides : OverridesDict, parent_names: List[str]) -> str:

    # Identify any placeholders in the prompt that match ${name}, ignoring any whitespace in the placeholder
    placeholders = re.findall(r"\${\s*(\w+)\s*}", raw_prompt)

    if len(placeholders) == 0:
        if len(parent_names) == 0:
            # Don't bother printing this message if we're in a recursive call
            print("No placeholders found in the prompt.")
        return raw_prompt
    
    print(f"Compiling prompt for {name}...")

    # create a dictionary to store the values of the placeholders
    placeholder_values: Dict[str, str] = {}

    # Iterate over the placeholders
    for placeholder in placeholders:

        if placeholder in parent_names:
            raise Exception(f"Circular dependency detected: {parent_names} -> {placeholder}")
        
        # check that placeholder matches [a-zA-Z][a-zA-Z0-9_]*
        if not re.match(r"^[_a-zA-Z][a-zA-Z0-9_]*$", placeholder):
            raise Exception(f"Invalid placeholder name {placeholder}")
        
        #check if first charactter of placeholder is _
        if placeholder[0] == '_':
            # throw if it's not in special placeholders
            if placeholder not in SPECIAL_PLACEHOLDERS:
                raise Exception(f"Invalid special placeholder name {placeholder}")

        print(f"Getting value for {placeholder}...")
        # Store the value in the dictionary
        value = fetch_placeholder(placeholder, timestamp, overrides, parent_names + [name])
        placeholder_values[placeholder] = compile_prompt(placeholder, value, timestamp, overrides, parent_names + [name])

    # Replace the placeholders with the values
    prompt = raw_prompt
    for placeholder, value in placeholder_values.items():
        prompt = prompt.replace(f"${{{placeholder}}}", value)

    # Return the compiled prompt
    return prompt


def execute_prompt(name: str, variations : Optional[Dict[str, str]], raw_prompt: str, timestamp : str, overrides: OverridesDict, parent_names: Optional[List[str]] = None) -> None:

    if parent_names is None:
        parent_names = []

    if not variations:
        variations = {}
        variations[name] = raw_prompt

    # Generate the output directory path
    output_dir = f"./target/{name}/{timestamp}"
    os.makedirs(output_dir, exist_ok=True)

    for variation_name, variation_content in variations.items():

        overrides[INPUT_OVERRIDE_NAME] = variation_name
        overrides[INPUT_CONTENTS_OVERRIDE_NAME] = variation_content

        # Compile the prompt
        prompt = compile_prompt(name, raw_prompt, timestamp, overrides, parent_names)

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
        
        # Create the soft link '_latest' pointing to the timestamp directory
        latest_link = f"./target/{name}/_latest"
        if os.path.exists(latest_link):
            os.unlink(latest_link)
        os.symlink(timestamp, latest_link, target_is_directory=True)

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
                if arg_name in SPECIAL_PLACEHOLDERS:
                    print(f"Cannot override special placeholder {arg_name}")
                    sys.exit(1)
                overrides[arg_name] = arg_value.strip('"')

    # Read the contents of the prompt file
    with open(prompt_file, 'r') as file:
        prompt_contents = file.read()

    # Generate a timestamp, do it now so we'll use the same one in multiple runs in multi-mode.
    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")

    if sys.stdin.isatty():
        # normal mode, nothing being piped.
        # Execute the prompt
        execute_prompt(prompt_base_filename, None, prompt_contents, timestamp, overrides)
    else:
        print("Entering multi-line mode (reading from stdin)...")
        variations : Dict[str, str] = {}
        # multi-line mode, something being piped.
        # for each line in stdin, execute the prompt with that line as the input override
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            content = ''
            # if the line is a valid filename, read the file contents
            if os.path.exists(line):
                with open(line, 'r') as file:
                    content = file.read()

            key = sanitize_string(line)
            variations[key] = content
        execute_prompt(prompt_base_filename, variations, prompt_contents, timestamp, overrides)

if __name__ == '__main__':
    main()