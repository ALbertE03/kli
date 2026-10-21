import os
import tempfile

_tmp = tempfile.mkdtemp(prefix="harness-test-")
os.environ.update(
    {
        "DATA_DIR": f"{_tmp}/data",
        "WORKSPACE_DIR": f"{_tmp}/ws",
        "PROJECTS_DIR": f"{_tmp}/projects",
        "PROJECTS_IMPORT_ROOTS": _tmp,  # permitido importar carpetas dentro del tmp
        "CHECKPOINT_BACKEND": "memory",
        "STORE_BACKEND": "memory",
        "API_KEYS": "",
        "HARNESS_ENV": "dev",
        "ENABLE_EXEC": "false",
        "MCP_CONFIG_FILE": "",
        # clave Fernet de pruebas: el .env local puede traer otra (o ninguna)
        "SECRET_KEY": "x6hd-OGd0dHp-_p98jYkJP8GFTHM_aY5tneXL7RcxxM=",
    }
)
