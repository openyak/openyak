# SSE streaming with a per-job replay buffer and Last-Event-ID resume

Each streaming generation is a **GenerationJob** (`backend/app/streaming/manager.py`) with a stream id and a bounded in-memory event ring buffer (~5000 events). The frontend consumes Server-Sent Events; on disconnect/reconnect the client sends `Last-Event-ID`, the server replays from that point, and the frontend dedupes (`frontend/src/lib/sse.ts`, `frontend/src/stores/chat-store.ts`).

A long agent run can take minutes, and the Tauri webview, mobile browser, and remote tunnel all drop connections under real conditions. Plain SSE without resume would force a full regeneration on every blip; switching to WebSockets would still leave us writing our own resume protocol. Buffered SSE is HTTP-friendly (works through any proxy or tunnel), survives reconnects without re-running Tools, and the bound on buffer size keeps it backpressure-safe.
