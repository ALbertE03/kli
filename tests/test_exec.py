"""Tests de las tools de ejecución: cwd confinado y exec bloqueado en producción."""

from collections.abc import Iterator
from pathlib import Path

import pytest

from harness.config import Settings
from harness.plugins.tools import codigo


@pytest.fixture
def exec_on(monkeypatch) -> Iterator[None]:
    """Activa el exec para las pruebas (el conftest lo apaga)."""
    monkeypatch.setattr(
        codigo,
        "_settings",
        Settings(enable_exec=True, harness_env="dev"),
    )
    codigo.make_exec_tools.cache_clear()
    yield
    codigo.make_exec_tools.cache_clear()


def test_exec_is_off_without_the_flag(monkeypatch):
    monkeypatch.setattr(
        codigo, "_settings", Settings(enable_exec=False, harness_env="dev")
    )
    codigo.make_exec_tools.cache_clear()
    assert codigo.exec_enabled() is False
    assert codigo.make_exec_tools("/tmp") == {}


def test_exec_needs_an_explicit_flag_in_prod(monkeypatch):
    """En producción el exec no está aislado: sin bandera, no se registra."""
    monkeypatch.setattr(
        codigo,
        "_settings",
        Settings(enable_exec=True, harness_env="prod", allow_unsandboxed_exec=False),
    )
    codigo.make_exec_tools.cache_clear()
    assert codigo.exec_enabled() is False

    monkeypatch.setattr(
        codigo,
        "_settings",
        Settings(enable_exec=True, harness_env="prod", allow_unsandboxed_exec=True),
    )
    codigo.make_exec_tools.cache_clear()
    assert codigo.exec_enabled() is True


def test_the_shell_runs_in_the_project_root(exec_on, tmp_path: Path):
    (tmp_path / "nota.txt").write_text("dentro\n", encoding="utf-8")
    shell = codigo.make_exec_tools(str(tmp_path))["terminal"]
    assert shell.run("pwd").strip() == str(tmp_path.resolve())
    assert "dentro" in shell.run("cat nota.txt")


def test_python_repl_runs_in_a_subprocess_in_the_root(exec_on, tmp_path: Path):
    (tmp_path / "nota.txt").write_text("dentro\n", encoding="utf-8")
    runner = codigo.make_exec_tools(str(tmp_path))["python_repl"]
    out = runner.run(
        {"code": "import os;print(os.getcwd());print(open('nota.txt').read().strip())"}
    )
    assert str(tmp_path.resolve()) in out
    assert "dentro" in out


def test_python_repl_does_not_take_the_server_down(exec_on, tmp_path: Path):
    """Un `sys.exit()` en el código no puede tumbar la API: va en un subproceso."""
    runner = codigo.make_exec_tools(str(tmp_path))["python_repl"]
    out = runner.run({"code": "import sys;print('hola');sys.exit(3)"})
    assert "hola" in out
    assert "exit 3" in out
