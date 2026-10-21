from harness.plugins.tools.dev import make_dev_tools


def _make(tmp_path):
    return make_dev_tools(str(tmp_path))


def test_code_search_finds_matches_and_reports_location(tmp_path):
    (tmp_path / "app.py").write_text("def hola():\n    return 1\n", encoding="utf-8")
    out = _make(tmp_path)["code_search"].invoke({"pattern": "hola"})
    assert "app.py:1" in out
    assert "def hola" in out


def test_code_search_stays_inside_root(tmp_path):
    secret = tmp_path.parent / "fuera_del_root.py"
    secret.write_text("secreto_unico = 1\n", encoding="utf-8")
    try:
        tools = _make(tmp_path / "proyecto")
        (tmp_path / "proyecto").mkdir(exist_ok=True)
        out = tools["code_search"].invoke({"pattern": "secreto_unico", "path": ".."})
        assert "fuera del proyecto" in out
        out = tools["code_search"].invoke({"pattern": "secreto_unico"})
        assert "sin coincidencias" in out.lower()
    finally:
        secret.unlink(missing_ok=True)


def test_python_outline_lists_symbols_with_lines(tmp_path):
    (tmp_path / "mod.py").write_text(
        "class A:\n    def f(self, x: int) -> int:\n        return x\n\nasync def g():\n    pass\n",
        encoding="utf-8",
    )
    out = _make(tmp_path)["python_outline"].invoke({"path": "mod.py"})
    assert "class A" in out and "# L1" in out
    assert "def f(self, x: int) -> int" in out and "# L2" in out
    assert "async def g()" in out


def test_python_outline_reports_syntax_errors(tmp_path):
    (tmp_path / "roto.py").write_text("def (:\n", encoding="utf-8")
    out = _make(tmp_path)["python_outline"].invoke({"path": "roto.py"})
    assert "SyntaxError" in out


def test_file_tree_skips_ignored_dirs(tmp_path):
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "m.py").write_text("x = 1\n", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "junk.js").write_text("//\n", encoding="utf-8")
    out = _make(tmp_path)["file_tree"].invoke({})
    assert "pkg/" in out and "m.py" in out
    assert "node_modules" not in out


def test_git_tools_report_when_not_a_repo(tmp_path):
    tools = _make(tmp_path)
    assert "git" in tools["git_status"].invoke({}).lower()


def test_run_tests_executes_pytest_in_root(tmp_path):
    (tmp_path / "test_ok.py").write_text("def test_ok():\n    assert True\n", encoding="utf-8")
    out = _make(tmp_path)["run_tests"].invoke({"args": "-q"})
    assert "exit 0" in out
