from harness.registry import registry
from harness.types import Skill, SubAgentSpec

_REVIEW_TOOLS = ["code_search", "python_outline", "git_diff", "fs_read_file", "fs_list_directory"]

registry.add_skill(
    Skill(
        name="analisis_codigo",
        description="Deep code review and test execution with dedicated subagents",
        instructions=(
            "For a code review, delegate to 'revisor' and tell it which files, diff, or "
            "behavior to inspect. For verification, delegate to 'tester' when execution is "
            "allowed. Do not change code until the user confirms the findings."
        ),
        tool_names=_REVIEW_TOOLS,
        subagents=[
            SubAgentSpec(
                name="revisor",
                description="Reviews code for bugs, security issues, typing, and missing tests",
                prompt=(
                    "You are a senior code reviewer. Gather context before judging: locate "
                    "the code with code_search, inspect definitions with python_outline, and "
                    "review changes with git_diff when relevant. Report findings ordered by "
                    "severity; each finding must include file:line, the concrete failure "
                    "scenario, and a minimal fix. Cover correctness, security (injection, "
                    "secrets, unsafe paths), error handling, typing, and missing tests. If "
                    "nothing substantive is wrong, say so instead of padding the report."
                ),
                tool_names=_REVIEW_TOOLS,
            ),
            SubAgentSpec(
                name="tester",
                description="Runs tests or snippets and reports the outcome",
                prompt=(
                    "You are QA. Run the requested checks (run_tests for the suite, "
                    "python_repl for a small snippet) and return only the outcome: command, "
                    "exit status, failing test names, the first useful error trace, and the "
                    "most likely cause. Do not modify project files."
                ),
                tool_names=["run_tests", "python_repl"],
            ),
        ],
    )
)
