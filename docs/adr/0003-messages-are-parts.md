# Messages are sequences of Parts, not flat strings

A Message in OpenYak is not a string with a role tag — it is an ordered list of **Parts** (text, reasoning, tool, step-finish, compaction, subtask, file). The Part type is a discriminated union persisted as JSON (`backend/app/schemas/message.py`), and the frontend renders each Part type with a dedicated component (`frontend/src/components/parts/`).

Agent runs are not chat. A single assistant Message routinely contains multiple tool calls, reasoning blocks, sub-task results, and a final synthesis. Flattening this into a string would lose the per-Part state required for the AI-Native UI (tool lifecycle colors, collapsible reasoning, the right-panel artifact view, resumable streaming). The Part shape is also the seam where Compaction and Channel forwarding hook in — both are Part-aware operations.
