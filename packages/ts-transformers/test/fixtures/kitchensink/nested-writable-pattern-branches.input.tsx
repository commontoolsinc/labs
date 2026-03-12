/// <cts-enable />
/**
 * FIXTURE: nested-writable-pattern-branches
 * Verifies: pattern-owned maps on explicit Writable inputs stay pattern-lowered
 * across mixed authored ifElse helpers, implicit JSX ternaries, nested maps,
 * and handler closures that capture values from several upper scopes.
 * Expected transform:
 * - state.sections.map(...) and section.tasks.map(...) become mapWithPattern()
 * - authored ifElse predicates and branches lower uniformly
 * - nested ternaries inside task/tag callbacks lower without extra derive noise
 * - handler captures preserve section/task/index/local Writable references
 */
import { computed, handler, ifElse, pattern, UI, Writable } from "commontools";

interface Task {
  id: string;
  label: string;
  done: boolean;
  tags: string[];
  note?: string;
}

interface Section {
  id: string;
  title: string;
  expanded: boolean;
  accent?: string;
  tasks: Task[];
}

const selectTask = handler<unknown, {
  selectedTaskId: string | undefined;
  hoveredSectionId: string | undefined;
  sectionId: string;
  taskId: string;
  sectionIndex: number;
  taskIndex: number;
}>((_event, state) => state);

export default pattern<{
  sections: Writable<Section[]>;
  showCompleted: boolean;
  globalAccent: string;
}>((state) => {
  const selectedTaskId = Writable.of<string | undefined>();
  const hoveredSectionId = Writable.of<string | undefined>();
  const hasSections = computed(() => state.sections.get().length > 0);

  return {
    [UI]: (
      <div>
        {ifElse(
          hasSections,
          <div>
            {state.sections.map((section, sectionIndex) => (
              <section>
                <h2
                  style={{
                    color: section.accent ? section.accent : state.globalAccent,
                  }}
                >
                  {section.title}
                </h2>
                {ifElse(
                  section.expanded,
                  <div>
                    {section.tasks.map((task, taskIndex) => (
                      <div>
                        <button
                          onClick={selectTask({
                            selectedTaskId,
                            hoveredSectionId,
                            sectionId: section.id,
                            taskId: task.id,
                            sectionIndex,
                            taskIndex,
                          })}
                        >
                          {task.done
                            ? <span>{task.label}</span>
                            : ifElse(
                              task.note !== undefined && task.note !== "",
                              <strong>{task.label}</strong>,
                              <em>{task.label}</em>,
                            )}
                        </button>
                        {task.tags.map((tag, tagIndex) => (
                          <span>
                            {tagIndex === taskIndex
                              ? `${section.title}:${tag}`
                              : state.showCompleted || !task.done
                              ? tag
                              : ""}
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>,
                  section.tasks.length > 0
                    ? <small>{section.title} collapsed</small>
                    : <small>empty</small>,
                )}
              </section>
            ))}
          </div>,
          <p>{state.showCompleted ? "No completed sections" : "No sections"}</p>,
        )}
      </div>
    ),
  };
});
