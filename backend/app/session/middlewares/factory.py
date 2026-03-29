"""Build the middleware chain for a session processor.

Constructs and orders the middleware chain based on configuration and
the current agent. The ordering matters and is documented here:

  1. DanglingToolCallMiddleware — must run first to fix message history
  2. LoopDetectionMiddleware — check for loops before tool execution
  3. TodoReminderMiddleware — append reminders after tool execution

Future additions should be inserted at the appropriate position in
this ordering.
"""

from __future__ import annotations

from typing import Any, Callable

from app.session.middleware import MiddlewareChain
from app.session.middlewares.dangling_tool_call import DanglingToolCallMiddleware
from app.session.middlewares.loop_detection import LoopDetectionMiddleware
from app.session.middlewares.todo_reminder import TodoReminderMiddleware
def build_middleware_chain(
    *,
    get_todos_fn: Callable[[], list[dict[str, Any]]] | None = None,
) -> MiddlewareChain:
    """Build the default middleware chain.

    Args:
        get_todos_fn: Optional callable returning current todos for
                      the TodoReminderMiddleware.
    """
    chain = MiddlewareChain()

    # 1. Fix dangling tool calls before LLM sees message history
    chain.add(DanglingToolCallMiddleware())

    # 2. Two-stage loop detection (warn → block)
    chain.add(LoopDetectionMiddleware())

    # 3. Todo reminders after modifying tools
    chain.add(TodoReminderMiddleware(get_todos_fn=get_todos_fn))

    return chain
