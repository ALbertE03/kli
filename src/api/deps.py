import re
import secrets
from typing import Annotated

from fastapi import Depends, Header, Request

from harness.config import get_settings
from harness.errors import Unauthorized
from harness.runtime import Runtime

_USER_RE = re.compile(r"^[A-Za-z0-9_.@-]{1,64}$")


def get_runtime(request: Request) -> Runtime:
    rt: Runtime = request.app.state.runtime
    return rt


async def current_user(
    authorization: Annotated[str | None, Header()] = None,
    x_user_id: Annotated[str | None, Header()] = None,
) -> str:
    """Con API_KEYS configuradas exige Bearer; sin ellas (solo dev) confía en X-User-Id."""
    keys = get_settings().api_key_map
    if keys:
        token = (authorization or "").removeprefix("Bearer ").strip()
        user = next((u for k, u in keys.items() if secrets.compare_digest(k, token)), None)
        if user is None:
            raise Unauthorized("API key inválida")
        return user
    user = x_user_id or "anonymous"
    if not _USER_RE.match(user):
        raise Unauthorized("X-User-Id inválido")
    return user


User = Annotated[str, Depends(current_user)]
Rt = Annotated[Runtime, Depends(get_runtime)]
