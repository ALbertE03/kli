from harness.registry import registry
from harness.types import Skill, SubAgentSpec

registry.add_skill(
    Skill(
        name="depuracion",
        description="Root-cause debugging from evidence instead of guesses",
        instructions=(
            "Use this skill when a bug, failing test, or unexpected behavior needs a root "
            "cause. Delegate evidence gathering to 'rastreador' and require a minimal, "
            "testable fix proposal before touching code."
        ),
        tool_names=["code_search", "python_outline", "git_diff", "fs_read_file"],
        subagents=[
            SubAgentSpec(
                name="rastreador",
                description="Traces a bug through the code and reports the root cause with evidence",
                prompt=(
                    "You are a debugging specialist. Build the reasoning path from symptom "
                    "to root cause: locate the relevant code with code_search, inspect "
                    "definitions with python_outline, and check recent changes with git_diff. "
                    "Return: the failing path (file:line), the root cause, the minimal fix, "
                    "and how to verify it. Never guess: if evidence is missing, state exactly "
                    "what should be inspected next."
                ),
                tool_names=[
                    "code_search",
                    "python_outline",
                    "git_diff",
                    "fs_read_file",
                    "fs_list_directory",
                ],
            ),
        ],
    )
)
