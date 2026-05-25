"""Compatibility exports for offline evaluation module after app/core reorganization."""

import sys

from app.core.offline_eval import *  # noqa: F403
from app.core.offline_eval import main as _core_main


if __name__ == "__main__":
    sys.exit(_core_main())
