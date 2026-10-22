"""System modes. Allowed tool categories are enforced in code, not just in the prompt."""

from harness.registry import registry
from harness.types import Mode, ToolCategory

MEMORY_TOOLS = ("remember", "recall", "forget")

# La búsqueda web (web_search/deep_search) NO está aquí: son tools opt-in y
# solo se cargan cuando el usuario las activa (ver harness.registry).
READ_ONLY_TOOLS = (
    "fs_read_file",
    "fs_list_directory",
    "fs_file_search",
)

# Tools de desarrollo (solo lectura del proyecto): disponibles en ambos modos
DEV_TOOLS = (
    "code_search",
    "file_tree",
    "python_outline",
    "git_status",
    "git_diff",
    "git_log",
)

registry.add_mode(
    Mode(
        name="plan",
        description="Read-only research and design: inspect code, git history, and sources",
        instructions=(
            "Plan mode is read-only: explore, analyze, and design before anything changes.\n"
            "- Ground every statement in evidence: locate the relevant files with code_search "
            "or file_tree, read them, and check git history when it explains the current state.\n"
            "- Name exact files, functions, and line numbers; never invent paths or APIs.\n"
            "- State assumptions and open questions explicitly instead of guessing silently.\n"
            "- Deliver an ordered plan: for each step, the exact change, the files involved, "
            "risks, and how the result will be verified.\n"
            "- Never modify files or run side-effecting actions; describe the change so it can "
            "be executed later in build mode."
        ),
        categories=frozenset({ToolCategory.READ, ToolCategory.NETWORK, ToolCategory.MEMORY}),
        base_tool_names=(*READ_ONLY_TOOLS, *DEV_TOOLS, *MEMORY_TOOLS),
    )
)

registry.add_mode(
    Mode(
        name="build",
        description="Implements tasks end-to-end with file, git, and test tools",
        instructions=(
            "Build mode implements the task end-to-end inside the workspace.\n"
            "- Read before writing: open the files you will change and follow the existing "
            "style, naming, and patterns; keep the diff minimal and focused.\n"
            "- Search the whole project before changing a shared symbol: other call sites and "
            "tests may depend on the current behavior.\n"
            "- Verify as you go: re-read the edited code, check syntax/outline, run the test "
            "suite (run_tests) when available, and fix what you break.\n"
            "- Destructive or irreversible actions need user approval: explain the impact "
            "before requesting it.\n"
            "- Finish with what changed, how it was verified, and anything left pending."
        ),
        categories=frozenset(
            {
                ToolCategory.READ,
                ToolCategory.WRITE,
                ToolCategory.NETWORK,
                ToolCategory.EXEC,
                ToolCategory.MEMORY,
            }
        ),
        base_tool_names=(
            *READ_ONLY_TOOLS,
            *DEV_TOOLS,
            "fs_write_file",
            "fs_copy_file",
            "fs_move_file",
            "fs_file_delete",
            "python_repl",
            "terminal",
            "run_tests",
            *MEMORY_TOOLS,
        ),
        approval_required=frozenset(
            {"python_repl", "terminal", "run_tests", "fs_file_delete", "fs_move_file"}
        ),
    )
)
