"""Rapid-MLX detection helpers.

Rapid-MLX (https://github.com/raullenchai/Rapid-MLX) is the recommended local
model server on macOS. OpenYak does not bundle it; users install it themselves
via ``brew install raullenchai/rapid-mlx/rapid-mlx`` or ``pip install rapid-mlx``,
then run ``rapid-mlx serve <model>`` to get an OpenAI-compatible endpoint at
``http://localhost:8000/v1``.

This module only *detects* the CLI; lifecycle management is deferred until the
user opts into a future sidecar bundling pass.
"""

from app.rapid_mlx.detect import RapidMlxStatus, detect_rapid_mlx

__all__ = ["RapidMlxStatus", "detect_rapid_mlx"]
