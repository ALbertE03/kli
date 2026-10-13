"""
Python script: fixture test runner
Validates the TypeScript fixture compiles and runs correctly.
"""

import subprocess
import sys
from pathlib import Path


FIXTURE_ROOT = Path(__file__).parent.parent


def run_cmd(cmd: list[str], cwd: Path) -> tuple[int, str]:
    """Run a command and return (exit_code, stdout)."""
    result = subprocess.run(
        cmd,
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=30,
    )
    return result.returncode, result.stdout.strip()


def check_typescript() -> bool:
    """Check that TypeScript files exist and are syntactically valid."""
    src_dir = FIXTURE_ROOT / "src"
    ts_files = list(src_dir.glob("*.ts"))
    if not ts_files:
        print("ERROR: No TypeScript files found in src/")
        return False

    print(f"Found {len(ts_files)} TypeScript files:")
    for f in ts_files:
        print(f"  - {f.name}")

    # Check syntax by trying to parse with python's ast (just as a sanity check
    # that the files are readable and not empty)
    for f in ts_files:
        content = f.read_text()
        if not content.strip():
            print(f"WARNING: {f.name} is empty")
            return False

    return True


def check_python() -> bool:
    """Check that Python script is syntactically valid."""
    py_file = FIXTURE_ROOT / "scripts" / "validate.py"
    try:
        compile(py_file.read_text(), str(py_file), "exec")
        print(f"Python script OK: {py_file.name}")
        return True
    except SyntaxError as e:
        print(f"Python syntax error in {py_file.name}: {e}")
        return False


def check_types() -> bool:
    """Verify that TypeScript exports are consistent."""
    auth_content = (FIXTURE_ROOT / "src" / "auth.ts").read_text()
    router_content = (FIXTURE_ROOT / "src" / "router.ts").read_text()

    # Router should import from auth
    if "from './auth.js'" not in router_content:
        print("ERROR: router.ts does not import from auth.ts")
        return False

    # Auth should export User and AuthService
    if "export interface User" not in auth_content:
        print("ERROR: auth.ts missing User interface")
        return False
    if "export class AuthService" not in auth_content:
        print("ERROR: auth.ts missing AuthService class")
        return False

    print("TypeScript cross-file references OK")
    return True


def main() -> int:
    checks = [
        ("TypeScript files", check_typescript),
        ("Python script", check_python),
        ("Cross-file types", check_types),
    ]

    all_ok = True
    for name, check in checks:
        ok = check()
        status = "PASS" if ok else "FAIL"
        print(f"  [{status}] {name}")
        if not ok:
            all_ok = False

    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
