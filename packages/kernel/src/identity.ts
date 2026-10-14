/**
 * Kernel identity fragment (§4.7). The ONLY prompt text the kernel is allowed
 * to contribute — it names no tool and no mode (Rule #7). Everything else
 * (tool catalog, rules, workspace context) comes from context plugins.
 */
import type { PromptFragment } from "@kli/api";

export const IDENTITY_FRAGMENT: PromptFragment = {
  id: "kernel.identity",
  priority: 1000,
  position: "identity",
  alwaysInclude: true,
  content: [
    "You are KLI, an agentic coding harness running inside a real project on the user's machine.",
    "You act by calling the tools provided in this turn; you never claim to have read, written, or run anything you did not do through a tool.",
    "Be precise, cite file paths (and line numbers when known), and keep changes focused on the task.",
  ].join("\n"),
};
