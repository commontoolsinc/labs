import sys
import os
import subprocess
import re
import argparse
from datetime import datetime
from typing import List, Dict, Optional

INPUT_OVERRIDE_NAME = '_input'

SPECIAL_PLACEHOLDERS = [INPUT_OVERRIDE_NAME]

def fetch_most_recent_target(name: str) -> Optional[str]:
    # looks for the file with the most recent name in /target/${name}/ and returns the contents
    if not os.path.exists(f"./target/{name}"):
        return None

    files = os.listdir(f"./target/{name}")
    if len(files) == 0:
        return None
    files.sort(reverse=True)
    most_recent_directory = files[0]

    with open(f"./target/{name}/{most_recent_directory}/{name}.txt", 'r') as file:
        return file.read()
    
def fetch_golden(name: str) -> Optional[str]:
    # check the golden directory exists
    if not os.path.exists('golden'):
        return None

    # Looks for the file in `golden/` with the basename ${name} (any extension) and returns the contents
    golden_files = [f for f in os.listdir('golden') if os.path.isfile(os.path.join('golden', f))]
    for file in golden_files:
        if os.path.splitext(file)[0] == name:
            with open(f"golden/{file}", 'r') as file:
                return file.read()
    
    return None

def fetch_include(name: str) -> Optional[str]:
    # Check for a file in `includes/` with the basename ${name} (any extension) and returns the contents

    if not os.path.exists('includes'):
        return None
    
    include_files = [f for f in os.listdir('includes') if os.path.isfile(os.path.join('includes', f))]
    for file in include_files:
        if os.path.splitext(file)[0] == name:
            with open(f"includes/{file}", 'r') as file:
                return file.read()
        
    return None

def fetch_raw_prompt(name: str) -> Optional[str]:
    # Check for a file in `prompts/` with the basename ${name} (any extension) and returns the contents
    if not os.path.exists('prompts'):
        return None
    
    prompt_files = [f for f in os.listdir('prompts') if os.path.isfile(os.path.join('prompts', f))]
    for file in prompt_files:
        if os.path.splitext(file)[0] == name:
            with open(f"prompts/{file}", 'r') as file:
                return file.read()
    
    return None

def fetch_prompt(name: str, overrides : Dict[str, str], parent_names: List[str]) -> Optional[str]:
    # Fetch the raw prompt and compile it
    raw_prompt = fetch_raw_prompt(name)

    if not raw_prompt:
        return None
    
    print(f"Executing prompt for {name}...")
    execute_prompt(name, raw_prompt, overrides, parent_names)

    return fetch_most_recent_target(name)


def fetch_placeholder(name: str, overrides: Dict[str, str], parent_names: List[str]) -> str:

    # Override order:
    # 1. Explicitly provided placeholder_override
    # 2. A matching output file from golden/
    # 3. Most recent target output
    # 4. A matching file from `includes/`
    # 5. A matching file from `prompts/` (which will be compiled and executed)

    if name in overrides:
        print(f"Using placeholder override for {name}...")
        return overrides[name]

    value = fetch_golden(name)
    if value:
        print(f"Using golden file for {name}...")
        return value

    value = fetch_most_recent_target(name)
    if value:
        print(f"Using most recent target for {name}...")
        return value
    
    value = fetch_include(name)
    if value:
        print(f"Using include file for {name}...")
        return value

    value = fetch_prompt(name, overrides, parent_names)
    if value:
        # TODO: if this had to be compiled, this message comes after the compilation.
        print(f"Using prompt file for {name}...")
        return value
        
    raise Exception(f"Could not find value for placeholder {name}")

def compile_prompt(name: str, raw_prompt: str, overrides : Dict[str, str], parent_names: List[str]) -> str:

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
        value = fetch_placeholder(placeholder, overrides, parent_names + [name])
        placeholder_values[placeholder] = compile_prompt(placeholder, value, overrides, parent_names + [name])

    # Replace the placeholders with the values
    prompt = raw_prompt
    for placeholder, value in placeholder_values.items():
        prompt = prompt.replace(f"${{{placeholder}}}", value)

    # Return the compiled prompt
    return prompt


def execute_prompt(name: str, raw_prompt: str, overrides: Dict[str, str], parent_names: Optional[List[str]] = None) -> None:

    if parent_names is None:
        parent_names = []

    # Compile the prompt
    prompt = compile_prompt(name, raw_prompt, overrides, parent_names)

    output_base_name = name
    output_prompt_base_name = "_prompt"
    if overrides.get(INPUT_OVERRIDE_NAME):
        output_base_name = overrides[INPUT_OVERRIDE_NAME]
        output_prompt_base_name = f"{output_prompt_base_name}_{output_base_name}"

    try:
        print(f"Running llm command for {name}...")

        # Pipe the prompt contents to the llm command
        output = subprocess.check_output(['llm'], input=prompt, universal_newlines=True)

        # Generate the timestamp string in a human-readable format
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")

        # Generate the output directory path
        output_dir = f"./target/{name}/{timestamp}"
        os.makedirs(output_dir, exist_ok=True)

        # Generate the output file path
        output_file = f"{output_dir}/{output_base_name}.txt"

        # Save the output to the file
        with open(output_file, 'w') as file:
            file.write(output)

        prompt_output_file = f"{output_dir}/{output_prompt_base_name}.txt"
        with open(prompt_output_file, 'w') as file:
            file.write(prompt)

        print(f"Output saved to {output_file}")

    except subprocess.CalledProcessError as e:
        print(f"Error running llm command for {name}: {e}")
        sys.exit(1)

def main() -> None:
    parser = argparse.ArgumentParser(description='Process a prompt file.')
    parser.add_argument('prompt_file', help='Path to the prompt file')
    parser.add_argument('--overrides', nargs='+', action='append', help='Named override placeholders in the format ARG_1 VAL_1 ARG_2 VAL_2')

    args = parser.parse_args()

    prompt_file = args.prompt_file
    prompt_base_filename = os.path.splitext(os.path.basename(prompt_file))[0]

    overrides : Dict[str, str] = {}

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

    # Execute the prompt
    execute_prompt(prompt_base_filename, prompt_contents, overrides)

if __name__ == '__main__':
    main()