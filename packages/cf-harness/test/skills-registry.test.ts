import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  discoverHarnessSkills,
  loadHarnessSkillContext,
  parseHarnessSkillFile,
} from "../src/skills/registry.ts";

const writeSkill = async (
  root: string,
  name: string,
  content: string,
): Promise<void> => {
  const dir = join(root, name);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, "SKILL.md"), content);
};

Deno.test("parseHarnessSkillFile handles simple frontmatter and continued descriptions", () => {
  const parsed = parseHarnessSkillFile([
    "---",
    "name: cf",
    "description: Guide for using the cf CLI,",
    "  patterns, and Common Fabric runtime.",
    "user-invocable: false",
    "tags: [pattern, cli]",
    "---",
    "",
    "# CF CLI",
  ].join("\n"));

  assertEquals(parsed.frontmatter, {
    name: "cf",
    description:
      "Guide for using the cf CLI, patterns, and Common Fabric runtime.",
    "user-invocable": false,
    tags: ["pattern", "cli"],
  });
  assertEquals(parsed.body.trim(), "# CF CLI");
});

Deno.test({
  name:
    "discoverHarnessSkills scans skills, records diagnostics, and builds sandbox paths",
  permissions: { read: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "cf-harness-skills-" });
    try {
      await writeSkill(
        root,
        "pattern-dev",
        [
          "---",
          "name: pattern-dev",
          "description: Build Common Fabric patterns",
          "---",
          "",
          "# Pattern Dev",
        ].join("\n"),
      );
      await writeSkill(
        root,
        "z-duplicate",
        [
          "---",
          "name: pattern-dev",
          "description: Duplicate skill",
          "---",
          "",
          "# Duplicate",
        ].join("\n"),
      );
      await writeSkill(
        root,
        "bad",
        [
          "---",
          "name: bad",
          "---",
          "",
          "# Bad",
        ].join("\n"),
      );
      await writeSkill(
        join(root, "phase"),
        "pattern-ui",
        [
          "---",
          "name: pattern-ui",
          "description: Add UI polish",
          "user-invocable: false",
          "---",
          "",
          "# Pattern UI",
        ].join("\n"),
      );

      const registry = await discoverHarnessSkills({
        skillsRoot: root,
        sandboxSkillsRoot: "/workspace/labs/skills",
        generatedAt: "2026-04-30T21:30:00.000Z",
      });

      assertEquals(registry.type, "cf-harness.skill-registry");
      assertEquals(registry.generatedAt, "2026-04-30T21:30:00.000Z");
      assertEquals(
        registry.skills.map((skill) => skill.name),
        ["pattern-dev", "pattern-ui"],
      );
      assertEquals(
        registry.skills.find((skill) => skill.name === "pattern-dev")
          ?.sandboxSkillPath,
        "/workspace/labs/skills/pattern-dev/SKILL.md",
      );
      assertEquals(
        registry.skills.find((skill) => skill.name === "pattern-ui")
          ?.sandboxSkillDir,
        "/workspace/labs/skills/phase/pattern-ui",
      );
      assertEquals(
        registry.skills.find((skill) => skill.name === "pattern-ui")
          ?.frontmatter["user-invocable"],
        false,
      );
      assertEquals(
        registry.diagnostics.map((diagnostic) => diagnostic.code).sort(),
        ["duplicate-skill-name", "missing-description"],
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "discoverHarnessSkills rejects symlinked skills that resolve outside the root",
  permissions: { read: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "cf-harness-skills-" });
    const outside = await Deno.makeTempDir({
      prefix: "cf-harness-outside-skill-",
    });
    try {
      await writeSkill(
        outside,
        "outside",
        [
          "---",
          "name: outside",
          "description: Outside skill",
          "---",
          "",
          "# Outside",
        ].join("\n"),
      );
      await Deno.symlink(join(outside, "outside"), join(root, "outside"), {
        type: "dir",
      });

      const registry = await discoverHarnessSkills({
        skillsRoot: root,
        sandboxSkillsRoot: "/workspace/labs/skills",
      });

      assertEquals(registry.skills, []);
      assertEquals(
        registry.diagnostics.map((diagnostic) => diagnostic.code),
        ["skill-scan-outside-root"],
      );
    } finally {
      await Deno.remove(root, { recursive: true });
      await Deno.remove(outside, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "loadHarnessSkillContext returns structured context and activation artifacts",
  permissions: { read: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "cf-harness-skills-" });
    try {
      await writeSkill(
        root,
        "pattern-dev",
        [
          "---",
          "name: pattern-dev",
          "description: Build Common Fabric patterns",
          "---",
          "",
          "# Pattern Dev",
          "",
          "Read docs/common/ai/pattern-development-guide.md first.",
        ].join("\n"),
      );
      const registry = await discoverHarnessSkills({
        skillsRoot: root,
        sandboxSkillsRoot: "/workspace/labs/skills",
      });

      const context = await loadHarnessSkillContext({
        registry,
        skillNames: ["pattern-dev", "pattern-dev"],
        source: "cli-preload",
        runId: "run-skills",
        activatedAt: "2026-04-30T21:40:00.000Z",
      });

      assertEquals(context.activations, {
        type: "cf-harness.skill-activations",
        version: 1,
        generatedAt: "2026-04-30T21:40:00.000Z",
        activations: [{
          name: "pattern-dev",
          source: "cli-preload",
          runId: "run-skills",
          skillPath: join(root, "pattern-dev", "SKILL.md"),
          skillDir: join(root, "pattern-dev"),
          sandboxSkillPath: "/workspace/labs/skills/pattern-dev/SKILL.md",
          sandboxSkillDir: "/workspace/labs/skills/pattern-dev",
          digest: registry.skills[0].digest,
          activatedAt: "2026-04-30T21:40:00.000Z",
          cfcPromptRole: "context",
        }],
      });
      assertEquals(
        context.contextText.includes(
          '<skill_context name="pattern-dev" source="/workspace/labs/skills/pattern-dev/SKILL.md">',
        ),
        true,
      );
      assertEquals(context.contextText.includes("# Pattern Dev"), true);
      assertEquals(
        context.contextText.includes(
          "Skill directory: /workspace/labs/skills/pattern-dev",
        ),
        true,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "loadHarnessSkillContext rejects missing skill names with available choices",
  permissions: { read: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "cf-harness-skills-" });
    try {
      await writeSkill(
        root,
        "pattern-dev",
        [
          "---",
          "name: pattern-dev",
          "description: Build Common Fabric patterns",
          "---",
          "",
          "# Pattern Dev",
        ].join("\n"),
      );
      const registry = await discoverHarnessSkills({ skillsRoot: root });

      await assertRejects(
        () =>
          loadHarnessSkillContext({
            registry,
            skillNames: ["missing-skill"],
            source: "cli-preload",
            runId: "run-skills",
          }),
        Error,
        "skill not found: missing-skill; available skills: pattern-dev",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
