/**
 * @kli/context-skills — built-in skills
 */
import type { HarnessPlugin, SkillManifest } from "@kli/api";

const SKILLS: SkillManifest[] = [
  {
    id: "skill.explain-code",
    name: "Explain Code",
    description: "Explain how code works",
    version: "1.0.0",
    triggers: [{ type: "keyword", patterns: ["explain", "how does", "what does"] }],
    tools: [],
    prompt: "Explain the relevant code thoroughly.",
    capabilities: [],
  },
  {
    id: "skill.generate-tests",
    name: "Generate Tests",
    description: "Create unit tests for code",
    version: "1.0.0",
    triggers: [{ type: "keyword", patterns: ["test", "unit test", "generate tests"] }],
    tools: [],
    prompt: "Generate comprehensive unit tests for the identified code.",
    capabilities: [],
  },
  {
    id: "skill.refactor-extract",
    name: "Refactor Extract",
    description: "Extract a function or class",
    version: "1.0.0",
    triggers: [{ type: "keyword", patterns: ["refactor", "extract"] }],
    tools: [],
    prompt: "Extract the relevant code into a clean, reusable function or class.",
    capabilities: [],
  },
  {
    id: "skill.fix-failing-test",
    name: "Fix Failing Test",
    description: "Debug and fix failing tests",
    version: "1.0.0",
    triggers: [{ type: "keyword", patterns: ["fix test", "debug test", "failing test"] }],
    tools: [],
    prompt: "Analyze the failing test and fix the underlying issue.",
    capabilities: [],
  },
];

export const plugin: HarnessPlugin = {
  manifest: {
    id: "kli.context.skills",
    version: "1.0.0",
    apiVersion: "1",
    kind: ["context"] as Array<"tool" | "provider" | "context" | "policy">,
    entrypoint: "./dist/index.js",
    capabilities: [],
    priority: 5,
  },
  register(registry) {
    for (const skill of SKILLS) {
      registry.registerSkill(skill, this.manifest.id);
    }
  },
};

export default plugin;