"""Errores de dominio. La API los traduce a códigos HTTP."""


class HarnessError(Exception):
    status_code = 400

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class InvalidConfig(HarnessError):
    status_code = 422


class UpstreamError(HarnessError):
    """El proveedor remoto respondió mal o no respondió."""

    status_code = 502


class Unauthorized(HarnessError):
    status_code = 401


class Forbidden(HarnessError):
    status_code = 403


class NotFound(HarnessError):
    status_code = 404


class Conflict(HarnessError):
    status_code = 409
