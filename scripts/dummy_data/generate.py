import sys
import os
import subprocess
import re
from datetime import datetime

def fetch_placeholder(name):
    value = input(f"Enter the value for {name}: ")
    return value

def compile_prompt(name, raw_prompt):

    print(f"Compiling prompt for {name}...")

    # Identify any placeholders in the prompt that match ${name}, ignoring any whitespace in the placeholder
    placeholders = re.findall(r"\${\s*(\w+)\s*}", raw_prompt)

    if len(placeholders) == 0:
        print("No placeholders found in the prompt.")
        return raw_prompt

    # create a dictionary to store the values of the placeholders
    placeholder_values = {}

    # Iterate over the placeholders
    for placeholder in placeholders:
        print(f"Getting value for {placeholder}...")
        # Store the value in the dictionary
        placeholder_values[placeholder] = fetch_placeholder(placeholder)

    # Replace the placeholders with the values
    prompt = raw_prompt
    for placeholder, value in placeholder_values.items():
        prompt = prompt.replace(f"${{{placeholder}}}", value)

    # Return the compiled prompt
    return prompt


def execute_prompt(name, raw_prompt):

    # Compile the prompt
    prompt = compile_prompt(name, raw_prompt)

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