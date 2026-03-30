"""Memory tool — DISABLED.

The global memory system (facts + contexts with confidence scoring) has been
removed. This tool previously depended on app.memory.storage and
app.memory.models which no longer exist.

The workspace memory system (per-directory plain-text files) remains active
but is managed through separate workspace_memory_* modules, not this tool.

This file is kept as a placeholder. To re-enable an explicit memory tool,
rewrite it to use the workspace memory subsystem instead.
"""
