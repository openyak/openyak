# Compaction is materialized as a Part, not an ephemeral summarization

When a Session approaches the model's context window, the engine inserts a `compaction` Part into the Message stream that records what was summarized and what was dropped (`backend/app/session/compaction.py`, `backend/app/schemas/message.py`). The pre-compaction history is preserved in the database; only the compaction summary is sent to the model on subsequent turns.

Silent context trimming makes a Session feel like it's "forgetting" — confusing for users and for debuggers. Materializing it as a Part means (a) the UI can render the trim explicitly, (b) the dropped Messages remain recoverable from storage, (c) Channel forwarders see compaction as just another Part type instead of a special case, and (d) replays and exports stay deterministic. The cost is a slightly larger DB footprint, which is acceptable given local-first storage.
