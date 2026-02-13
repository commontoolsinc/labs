import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  BuiltInLLMMessage,
  Cell,
  derive,
  OpaqueRef,
  pattern,
} from "commontools";

describe("derive type inference", () => {
  // These tests are not meant to run, the test is that they compile correctly.
  function _doNotRun(): void {
    it("should unwrap OpaqueRef<T[]> to T[] in callback", () => {
      const messages = Cell.of<BuiltInLLMMessage[]>().getAsOpaqueRefProxy();

      const assistantCount = derive(messages, (msgs) => {
        // Type assertion to verify the type inference is correct
        // If this compiles, it means msgs is properly typed as Message[]
        const _typeCheck: BuiltInLLMMessage[] = msgs;
        return msgs.filter((m) => m.role === "assistant").length;
      });

      expect(assistantCount).toBeDefined();
    });

    it("should unwrap nested object types in OpaqueRef", () => {
      interface ComplexMessage {
        role: "user" | "assistant" | "system";
        content: string | { text: string; type: string }[];
      }

      const messages = Cell.of<ComplexMessage[]>().getAsOpaqueRefProxy();

      const lastMessage = derive(messages, (msgs) => {
        // Verify we can access array properties and methods
        if (!msgs || msgs.length === 0) return null;

        const last = msgs[msgs.length - 1];

        // Verify we can access nested properties with proper types
        const content = typeof last.content === "string"
          ? last.content
          : last.content.map((part) => part.text).join("");

        return { role: last.role, content };
      });

      expect(lastMessage).toBeDefined();
    });

    it("should handle primitive types", () => {
      const number = Cell.of<number>().getAsOpaqueRefProxy();
      const boolean = Cell.of<boolean>().getAsOpaqueRefProxy();
      const string = Cell.of<string>().getAsOpaqueRefProxy();

      const derivedNumber = derive(number, (num) => {
        // Type check: nums should be number[]
        const _typeCheck: number = num;
        return num + 1;
      });

      const derivedBoolean = derive(boolean, (bool) => {
        const _typeCheck: boolean = bool;
        return !bool;
      });

      const derivedString = derive(string, (str) => {
        const _typeCheck: string = str;
        return str + "!";
      });

      expect(derivedNumber).toBeDefined();
      expect(derivedBoolean).toBeDefined();
      expect(derivedString).toBeDefined();
    });

    it("should handle primitive array types", () => {
      const numbers = Cell.of<number[]>().getAsOpaqueRefProxy();

      const sum = derive(numbers, (nums) => {
        // Type check: nums should be number[]
        const _typeCheck: number[] = nums;
        return nums.reduce((acc, n) => acc + n, 0);
      });

      expect(sum).toBeDefined();
    });

    it("should handle nested array types", () => {
      const matrix = Cell.of<number[][]>().getAsOpaqueRefProxy();

      const flattened = derive(matrix, (m) => {
        // Type check: m should be number[][]
        const _typeCheck: number[][] = m;
        return m.flat();
      });

      expect(flattened).toBeDefined();
    });

    it("should handle object with nested properties", () => {
      interface User {
        member: boolean;
        name: string;
        email: string;
        profile: {
          age: number;
          city: string;
        };
      }

      const user = Cell.of<User>().getAsOpaqueRefProxy();

      const displayName = derive(user, (u) => {
        // Type check: u should be User
        const _typeCheck: User = u;
        const _member: boolean = u.member;
        return `${u.name} (${u.profile.city})`;
      });

      expect(displayName).toBeDefined();
    });

    it("should handle object with nested properties", () => {
      interface User {
        name: string;
        email: string;
        profile: {
          age: number;
          city: string;
        };
      }

      const user = Cell.of<User>().getAsOpaqueRefProxy();

      const displayName = derive({ user }, ({ user }) => {
        // Type check: u should be User
        const _typeCheck: User = user;
        return `${user.name} (${user.profile.city})`;
      });

      expect(displayName).toBeDefined();
    });

    it("should unwrap sub-properties of OpaqueRef (like omnibot.messages)", () => {
      interface Message {
        role: "user" | "assistant" | "system";
        content: string;
      }

      interface ChatbotState {
        messages: Message[];
        system: string;
        pending: boolean;
      }

      const chatbot = Cell.of<ChatbotState>().getAsOpaqueRefProxy();

      // This simulates the exact pattern from omnibox-fab.tsx:
      // derive(omnibot.messages, (messages) => ...)
      const assistantCount = derive(chatbot.messages, (messages) => {
        // Type check: messages should be Message[], not wrapped
        const _typeCheck: Message[] = messages;
        return messages.filter((m) => m.role === "assistant").length;
      });

      expect(assistantCount).toBeDefined();

      // Also test the other derive from omnibox-fab.tsx
      const latestAssistantMessage = derive(chatbot.messages, (messages) => {
        // Type check: messages should be Message[]
        const _typeCheck: Message[] = messages;

        if (!messages || messages.length === 0) return null;

        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (msg.role === "assistant") {
            return msg.content;
          }
        }
        return null;
      });

      expect(latestAssistantMessage).toBeDefined();
    });

    it("should handle the exact type structure from pattern return values", () => {
      // This tests chatbot.messages where chatbot is OpaqueRef<ChatOutput>
      // and messages is accessed as a property
      type Message = {
        role: "user" | "assistant";
        content: string;
      };

      type ChatOutput = {
        messages: Message[];
        pending: boolean;
      };

      // Simulate what happens when you call a pattern
      const chatbot = Cell.of<ChatOutput>().getAsOpaqueRefProxy();

      // Access messages property - this has type OpaqueCell<Message[]> & Array<OpaqueRef<Message>>
      const messages = chatbot.messages;

      // Log the actual type to understand what we're dealing with
      type MessagesType = typeof messages;
      // MessagesType should be: OpaqueCell<Message[]> & Array<OpaqueRef<Message>>

      // This is the exact pattern: derive(omnibot.messages, (messages) => ...)
      const result = derive(messages, (msgs) => {
        // This should compile without errors - msgs should be Message[]
        // This was the bug: msgs was being typed as the complex intersection type
        // Now it should be correctly unwrapped to Message[]
        const _typeCheck: Message[] = msgs;
        return msgs.filter((m) => m.role === "assistant").length;
      });

      expect(result).toBeDefined();
    });

    it("should handle array intersection types (OpaqueCell<T[]> & Array<OpaqueRef<T>>)", () => {
      // This explicitly tests the intersection type that occurs with sub-properties
      interface Item {
        id: number;
        name: string;
      }

      const parent = Cell.of<{ items: Item[] }>().getAsOpaqueRefProxy();

      // parent.items has type: OpaqueCell<Item[]> & Array<OpaqueRef<Item>>
      const items = parent.items;

      // The derive callback should receive Item[], not the complex wrapped type
      const count = derive(items, (itemsList) => {
        const _typeCheck: Item[] = itemsList;
        return itemsList.length;
      });

      expect(count).toBeDefined();
    });

    it("should handle pattern return values with array properties (actual omnibot.messages case)", () => {
      // This reproduces the ACTUAL bug from omnibox-fab.tsx
      interface ChatbotInput {
        initialMessage?: string;
      }

      interface ChatbotOutput {
        messages: BuiltInLLMMessage[];
      }

      // Create a pattern that returns an object with an array property
      const Chatbot = pattern<ChatbotInput, ChatbotOutput>("TestChatbot", () => {
        const messagesRef = Cell.of<BuiltInLLMMessage[]>()
          .getAsOpaqueRefProxy();

        return {
          messages: messagesRef,
        };
      });

      // Call the pattern - this is like `const omnibot = Chatbot(...)`
      const omnibot = Chatbot({});

      // Access the messages property - this is like `omnibot.messages`
      // This is where the type becomes Opaque<Message>[] instead of Message[]
      const assistantCount = derive(omnibot.messages, (messages) => {
        // This should be Message[], not Opaque<Message>[]
        const _typeCheck: BuiltInLLMMessage[] = messages;
        return messages.filter((m) => m.role === "assistant").length;
      });

      expect(assistantCount).toBeDefined();
    });

    it("should support destructuring derive inputs for nested properties", () => {
      const Chatbot = pattern<
        Record<string, never>,
        { messages: BuiltInLLMMessage[] }
      >(
        "ChatbotWithMessages",
        () => {
          const messagesRef = Cell.of<BuiltInLLMMessage[]>()
            .getAsOpaqueRefProxy();
          return {
            messages: messagesRef,
          };
        },
      );

      const omnibot = Chatbot({});

      const assistantCount = derive(
        { messages: omnibot.messages },
        ({ messages }) => {
          const _typeCheck: BuiltInLLMMessage[] = messages;
          return messages.filter((m) => m.role === "assistant").length;
        },
      );

      expect(assistantCount).toBeDefined();
    });

    describe("derive with Cell inputs", () => {
      interface UserProfile {
        name: string;
        active: boolean;
      }

      const profileCell = Cell.of<UserProfile>();
      profileCell.set({ name: "Ada", active: true });

      it("should unwrap Cell.of<T> inputs directly", () => {
        const result = derive(profileCell, (profile) => {
          const _typeCheck: Cell<UserProfile> = profile;
          return profile === profile ? 1 : 0;
        });

        expect(result).toBeDefined();
      });

      it("should unwrap OpaqueRef<Cell<T>> inputs", () => {
        const profileCellRef = profileCell as unknown as OpaqueRef<
          Cell<UserProfile>
        >;
        const isActive = derive(profileCellRef, (profile) => {
          const _typeCheck: Cell<UserProfile> = profile;
          return profile;
        });

        expect(isActive).toBeDefined();
      });

      it("should unwrap destructured objects containing Cell<T>", () => {
        const derived = derive({ profile: profileCell }, ({ profile }) => {
          const _typeCheck: Cell<UserProfile> = profile;
          return profile;
        });

        expect(derived).toBeDefined();
      });

      it("should unwrap destructured OpaqueRef objects containing Cell<T>", () => {
        const container = { profile: profileCell } as OpaqueRef<
          { profile: Cell<UserProfile> }
        >;
        const derived = derive(container, ({ profile }) => {
          const _typeCheck: Cell<UserProfile> = profile;
          return profile;
        });

        expect(derived).toBeDefined();
      });
    });

    it("should honor explicit derive<In, Out> typing", () => {
      type ExplicitInput = { role: "user"; text: string };
      const explicitCell = Cell.of<ExplicitInput>().getAsOpaqueRefProxy();

      const derived = derive<ExplicitInput, number>(
        explicitCell,
        (value) => {
          const _typeCheck: ExplicitInput = value;
          return value.text.length;
        },
      );

      expect(derived).toBeDefined();
    });

    it("should honor explicit parameter typing", () => {
      type ExplicitInput = { role: "user"; text: string };
      const explicitCell = Cell.of<ExplicitInput>().getAsOpaqueRefProxy();

      const derived = derive(
        explicitCell,
        (value: ExplicitInput) => {
          const _typeCheck: ExplicitInput = value;
          return value.text.length;
        },
      );

      expect(derived).toBeDefined();
    });

    it("should honor explicit Cell<T> inputs", () => {
      type ExplicitInput = { role: "user"; text: string };
      const explicitCell = Cell.of<Cell<ExplicitInput>>().getAsOpaqueRefProxy();

      const derived = derive(
        explicitCell,
        (value: Cell<ExplicitInput>) => {
          const _typeCheck: Cell<ExplicitInput> = value;
          return value.get().text.length;
        },
      );

      expect(derived).toBeDefined();
    });
  }
});
