import sys
import os
import subprocess
import re
from datetime import datetime

# TODO: store placeholder values provided from the command line here
placeholder_overrides = {}

def fetch_most_recent_target(name):
    # looks for the file with the most recent name in /target/${name}/ and returns the contents
    if not os.path.exists(f"./target/{name}"):
        return None

    files = os.listdir(f"./target/{name}")
    if len(files) == 0:
        return None
    files.sort(reverse=True)
    most_recent_file = files[0]

    with open(f"./target/{name}/{most_recent_file}", 'r') as file:
        return file.read()
    
def fetch_golden(name):
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

def fetch_include(name):
    # Check for a file in `includes/` with the basename ${name} (any extension) and returns the contents

    if not os.path.exists('includes'):
        return None
    
    include_files = [f for f in os.listdir('includes') if os.path.isfile(os.path.join('includes', f))]
    for file in include_files:
        if os.path.splitext(file)[0] == name:
            with open(f"includes/{file}", 'r') as file:
                return file.read()
        
    return None

def fetch_raw_prompt(name):
    # Check for a file in `prompts/` with the basename ${name} (any extension) and returns the contents
    if not os.path.exists('prompts'):
        return None
    
    prompt_files = [f for f in os.listdir('prompts') if os.path.isfile(os.path.join('prompts', f))]
    for file in prompt_files:
        if os.path.splitext(file)[0] == name:
            with open(f"prompts/{file}", 'r') as file:
                return file.read()
    
    return None

def fetch_prompt(name, parent_names):
    # Fetch the raw prompt and compile it
    raw_prompt = fetch_raw_prompt(name)

    if not raw_prompt:
        return None
    
    print(f"Executing prompt for {name}...")
    execute_prompt(name, raw_prompt, parent_names)

    return fetch_most_recent_target(name)


def fetch_placeholder(name, parent_names):

    # Override order:
    # 1. Explicitly provided placeholder_override
    # 2. A matching output file from golden/
    # 3. Most recent target output
    # 4. A matching file from `includes/`
    # 4. A matching file from `prompts/`

    if name in placeholder_overrides:
        print(f"Using placeholder override for {name}...")
        return placeholder_overrides[name]

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

    value = fetch_prompt(name, parent_names)
    if value:
        # TODO: if this had to be compiled, this message comes after the compilation.
        print(f"Using prompt file for {name}...")
        return value
        
    raise Exception(f"Could not find value for placeholder {name}")

def compile_prompt(name, raw_prompt, parent_names):

    # Identify any placeholders in the prompt that match ${name}, ignoring any whitespace in the placeholder
    placeholders = re.findall(r"\${\s*(\w+)\s*}", raw_prompt)

    if len(placeholders) == 0:
        print("No placeholders found in the prompt.")
        return raw_prompt
    
    print(f"Compiling prompt for {name}...")

    # create a dictionary to store the values of the placeholders
    placeholder_values = {}

    # Iterate over the placeholders
    for placeholder in placeholders:

        if placeholder in parent_names:
            raise Exception(f"Circular dependency detected: {parent_names} -> {placeholder}")

        print(f"Getting value for {placeholder}...")
        # Store the value in the dictionary
        value = fetch_placeholder(placeholder, parent_names + [name])
        placeholder_values[placeholder] = compile_prompt(placeholder, value, parent_names + [name])

    # Replace the placeholders with the values
    prompt = raw_prompt
    for placeholder, value in placeholder_values.items():
        prompt = prompt.replace(f"${{{placeholder}}}", value)

    # Return the compiled prompt
    return prompt


def execute_prompt(name, raw_prompt, parent_names = None):

    if parent_names is None:
        parent_names = []

    # Compile the prompt
    prompt = compile_prompt(name, raw_prompt, parent_names)

    try:
        print(f"Running llm command for {name}...")

        # Pipe the prompt contents to the llm command
        output = subprocess.check_output(['llm'], input=prompt, universal_newlines=True)

        # Generate the output directory path
        output_dir = f"./target/{name}"
        os.makedirs(output_dir, exist_ok=True)

        # Generate the timestamp string
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        # Generate the output file path
        output_file = f"{output_dir}/{timestamp}.txt"

        # Save the output to the file
        with open(output_file, 'w') as file:
            file.write(output)

        print(f"Output saved to {output_file}")

    except subprocess.CalledProcessError as e:
        print(f"Error running llm command for {name}: {e}")
        sys.exit(1)

def main():
    if len(sys.argv) != 2:
        print("Usage: python script.py <prompt_file>")
        sys.exit(1)

    prompt_file = sys.argv[1]
    prompt_base_filename = os.path.splitext(os.path.basename(prompt_file))[0]

    # Read the contents of the prompt file
    with open(prompt_file, 'r') as file:
        prompt_contents = file.read()

    # Execute the prompt
    execute_prompt(prompt_base_filename, prompt_contents)

if __name__ == '__main__':
    main()