import sys
import os
import subprocess
from datetime import datetime

def main():
    if len(sys.argv) != 2:
        print("Usage: python script.py <prompt_file>")
        sys.exit(1)

    prompt_file = sys.argv[1]
    prompt_base_filename = os.path.splitext(os.path.basename(prompt_file))[0]

    # Read the contents of the prompt file
    with open(prompt_file, 'r') as file:
        prompt_contents = file.read()

    try:
        print("Running llm command...")

        # Pipe the prompt contents to the llm command
        output = subprocess.check_output(['llm'], input=prompt_contents, universal_newlines=True)

        # Generate the output directory path
        output_dir = f"./target/{prompt_base_filename}"
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
        print(f"Error running llm command: {e}")
        sys.exit(1)

if __name__ == '__main__':
    main()