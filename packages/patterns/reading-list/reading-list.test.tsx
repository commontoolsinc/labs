/// <cts-enable />
/**
 * Test Pattern: Reading List
 *
 * Tests the core functionality of the reading-list pattern:
 * - Initial state (empty list)
 * - Adding items with different types
 * - Removing items
 * - Empty/whitespace title handling
 * - Item count in totalCount
 *
 * Run: deno task ct test packages/patterns/reading-list/reading-list.test.tsx --verbose
 */
import { action, computed, pattern } from "commontools";
import ReadingList from "./reading-list.tsx";

export default pattern(() => {
  // Instantiate the reading list pattern with default empty list
  const list = ReadingList({});

  // ==========================================================================
  // Actions
  // ==========================================================================

  // Add items of different types
  const action_add_article = action(() => {
    list.addItem.send({
      title: "Great Article",
      author: "Jane Doe",
      type: "article",
    });
  });

  const action_add_book = action(() => {
    list.addItem.send({
      title: "Amazing Book",
      author: "John Smith",
      type: "book",
    });
  });

  const action_add_paper = action(() => {
    list.addItem.send({
      title: "Research Paper",
      author: "Dr. Science",
      type: "paper",
    });
  });

  const action_add_video = action(() => {
    list.addItem.send({ title: "Tutorial Video", author: "", type: "video" });
  });

  // Empty/whitespace should be ignored
  const action_add_empty = action(() => {
    list.addItem.send({ title: "", author: "Author", type: "article" });
  });

  const action_add_whitespace = action(() => {
    list.addItem.send({ title: "   ", author: "Author", type: "article" });
  });

  // Remove items
  const action_remove_first = action(() => {
    const items = list.items;
    if (items && items[0]) {
      list.removeItem.send({ item: items[0] });
    }
  });

  // Remove second item (now first after previous remove)
  const action_remove_second = action(() => {
    const items = list.items;
    if (items && items[0]) {
      list.removeItem.send({ item: items[0] });
    }
  });

  // Remove third item (now first after previous removes)
  const action_remove_third = action(() => {
    const items = list.items;
    if (items && items[0]) {
      list.removeItem.send({ item: items[0] });
    }
  });

  // Remove fourth/last item
  const action_remove_fourth = action(() => {
    const items = list.items;
    if (items && items[0]) {
      list.removeItem.send({ item: items[0] });
    }
  });

  // ==========================================================================
  // Assertions
  // ==========================================================================

  // Initial state
  const assert_initial_empty = computed(() => {
    return list.totalCount === 0;
  });

  // After adding article
  const assert_has_one = computed(() => list.totalCount === 1);
  const assert_first_is_article = computed(() => {
    return list.items[0]?.title === "Great Article" &&
      list.items[0]?.type === "article" &&
      list.items[0]?.author === "Jane Doe";
  });

  // After adding book
  const assert_has_two = computed(() => list.totalCount === 2);
  const assert_second_is_book = computed(() => {
    return list.items[1]?.title === "Amazing Book" &&
      list.items[1]?.type === "book";
  });

  // After adding paper
  const assert_has_three = computed(() => list.totalCount === 3);

  // After adding video (with empty author)
  const assert_has_four = computed(() => list.totalCount === 4);
  const assert_video_has_empty_author = computed(() => {
    return list.items[3]?.title === "Tutorial Video" &&
      list.items[3]?.author === "";
  });

  // Empty/whitespace shouldn't add
  const assert_still_four = computed(() => list.totalCount === 4);

  // After removing first item
  const assert_has_three_after_remove = computed(() => list.totalCount === 3);
  const assert_first_is_now_book = computed(() => {
    return list.items[0]?.title === "Amazing Book";
  });

  // After removing all
  const assert_back_to_empty = computed(() => list.totalCount === 0);

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    tests: [
      // Initial state
      { assertion: assert_initial_empty },

      // Add items of different types
      { action: action_add_article },
      { assertion: assert_has_one },
      { assertion: assert_first_is_article },

      { action: action_add_book },
      { assertion: assert_has_two },
      { assertion: assert_second_is_book },

      { action: action_add_paper },
      { assertion: assert_has_three },

      { action: action_add_video },
      { assertion: assert_has_four },
      { assertion: assert_video_has_empty_author },

      // Empty/whitespace ignored
      { action: action_add_empty },
      { assertion: assert_still_four },
      { action: action_add_whitespace },
      { assertion: assert_still_four },

      // Remove items
      { action: action_remove_first },
      { assertion: assert_has_three_after_remove },
      { assertion: assert_first_is_now_book },

      // Remove remaining items one by one
      { action: action_remove_second },
      { action: action_remove_third },
      { action: action_remove_fourth },
      { assertion: assert_back_to_empty },
    ],
    // Expose subject for debugging
    list,
  };
});
