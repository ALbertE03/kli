import pytest

from harness.errors import Forbidden, InvalidConfig
from harness.security import assert_public_url, validate_headers, validate_stdio_command


def test_blocks_private_and_loopback():
    for url in ("http://127.0.0.1/", "http://10.0.0.5/", "http://169.254.169.254/latest"):
        with pytest.raises(Forbidden):
            assert_public_url(url)


def test_rejects_non_http_scheme():
    with pytest.raises(InvalidConfig):
        assert_public_url("file:///etc/passwd")


def test_public_ip_allowed():
    assert_public_url("http://8.8.8.8/")


def test_stdio_allowlist():
    validate_stdio_command("npx", frozenset({"npx"}))
    with pytest.raises(Forbidden):
        validate_stdio_command("bash", frozenset({"npx"}))


def test_header_injection_rejected():
    with pytest.raises(InvalidConfig):
        validate_headers({"X-A": "b\r\nX-Evil: 1"})
