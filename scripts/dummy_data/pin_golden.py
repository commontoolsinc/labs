import sys

from generate import pin

def main() -> None:
    # if no words are passed after the command, print an error message
    if len(sys.argv) == 1:
        print("Pass a list of placeholder names to pin their most recent versions")
        return

    # iterate through each word passed after the command
    for placeholder in sys.argv[1:]:
        pin(placeholder)

if __name__ == '__main__':
    main()