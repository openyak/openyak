"""Stop a bundled native payload from masquerading as the freetype-py module.

PyInstaller collects freetype's native library into a top-level directory named
``freetype`` inside ``_internal``, which is on ``sys.path``. Python therefore
resolves ``import freetype`` to that directory as an implicit namespace package:
the import succeeds but the module is empty.

reportlab probes for freetype-py with a plain ``import freetype`` and, seeing it
succeed, goes on to use it -- so the frozen backend died during startup with

    AttributeError: module 'freetype' has no attribute 'FT_LOAD_DEFAULT'

before it had served a single request. From source there is no ``freetype``
module at all, the probe fails cleanly, and reportlab takes its fallback path;
this hook restores that behaviour in the bundle.

Binding the name to None in sys.modules makes ``import freetype`` raise
ImportError, which is exactly what the probe expects. The real freetype DLL is
unaffected: it is loaded by the C extensions that link it, not through this
Python module name.
"""

import importlib.util
import sys


def _is_stub_namespace_package(name: str) -> bool:
    """True when `name` resolves only to a directory with no module code."""
    try:
        spec = importlib.util.find_spec(name)
    except (ImportError, ValueError):
        return False
    return spec is not None and spec.origin is None and spec.loader is None


if "freetype" not in sys.modules and _is_stub_namespace_package("freetype"):
    # A real freetype-py install would have a loader, so this only fires for
    # the collected-data directory.
    sys.modules["freetype"] = None
