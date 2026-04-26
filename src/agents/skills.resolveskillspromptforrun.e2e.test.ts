import { describe, expect, it } from "vitest";
import { resolveSkillsPromptForRun } from "./skills.js";
import type { SkillEntry } from "./skills/types.js";

describe("resolveSkillsPromptForRun", () => {
  it("prefers snapshot prompt when available", () => {
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: { prompt: "SNAPSHOT", skills: [] },
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toBe("SNAPSHOT");
  });
  it("builds prompt from entries when snapshot is missing", () => {
    const entry: SkillEntry = {
      skill: {
        name: "demo-skill",
        description: "Demo",
        filePath: "/app/skills/demo-skill/SKILL.md",
        baseDir: "/app/skills/demo-skill",
        source: "openclaw-bundled",
        disableModelInvocation: false,
      },
      frontmatter: {},
    };
    const prompt = resolveSkillsPromptForRun({
      entries: [entry],
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("/app/skills/demo-skill/SKILL.md");
  });

  it("applies skillFilter when snapshot is missing", () => {
    const entryA: SkillEntry = {
      skill: {
        name: "demo-skill",
        description: "Demo",
        filePath: "/app/skills/demo-skill/SKILL.md",
        baseDir: "/app/skills/demo-skill",
        source: "openclaw-bundled",
        disableModelInvocation: false,
      },
      frontmatter: {},
    };
    const entryB: SkillEntry = {
      skill: {
        name: "other-skill",
        description: "Other",
        filePath: "/app/skills/other-skill/SKILL.md",
        baseDir: "/app/skills/other-skill",
        source: "openclaw-bundled",
        disableModelInvocation: false,
      },
      frontmatter: {},
    };

    const prompt = resolveSkillsPromptForRun({
      entries: [entryA, entryB],
      workspaceDir: "/tmp/openclaw",
      skillFilter: ["other-skill"],
    });

    expect(prompt).toContain("other-skill");
    expect(prompt).not.toContain("demo-skill");
  });
});
