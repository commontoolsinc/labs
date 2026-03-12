/// <cts-enable />
/**
 * FIXTURE: helper-owned-compute-branches
 * Verifies: helper-owned branches inside computed() can mix compute-owned array
 * maps with reactive Writable captures without losing branch rewriting.
 * Expected transform:
 * - visibleProjects.map(...), project.badges.map(...), project.members.map(...),
 *   and plainPreview.map(...) remain plain Array.map() calls in compute context
 * - fallbackMembers.map(...) still lowers because it comes from a closed-over
 *   Writable array capture
 * - authored ifElse branches still lower safely around the mixed map behavior
 */
import { computed, ifElse, pattern, UI, Writable } from "commontools";

interface Badge {
  text: string;
  active: boolean;
}

interface Project {
  id: string;
  name: string;
  archived: boolean;
  members: string[];
  badges: Badge[];
}

export default pattern<{
  projects: Project[];
  prefix: string;
  showArchived: boolean;
}>((state) => {
  const fallbackMembers = Writable.of(["ops", "sales"]);
  const visibleProjects = computed(() =>
    state.showArchived
      ? state.projects
      : state.projects.filter((project) => !project.archived)
  );

  const rows = computed(() =>
    visibleProjects.map((project, projectIndex) => {
      const plainPreview = ["alpha", "beta"].map((label, labelIndex) =>
        `${project.name}-${labelIndex}-${label}`
      );

      return ifElse(
        project.badges.length > 0,
        <div>
          <h3>{project.name}</h3>
          {project.badges.map((badge, badgeIndex) => (
            <span>
              {badge.active
                ? `${state.prefix}${badge.text}-${projectIndex}`
                : badgeIndex === 0
                ? `${project.name}:${badge.text}`
                : ""}
            </span>
          ))}
          {fallbackMembers.map((member, memberIndex) => (
            <small>
              {memberIndex === 0 ? `${project.name}-${member}` : member}
            </small>
          ))}
          {plainPreview.map((label) => <i>{label}</i>)}
        </div>,
        <div>
          {project.members.map((member, memberIndex) => (
            <span>
              {memberIndex === projectIndex
                ? `${state.prefix}${member}`
                : member}
            </span>
          ))}
        </div>,
      );
    })
  );

  return {
    [UI]: <div>{rows}</div>,
  };
});
