# Backend runs as a subprocess of the Tauri shell

The desktop app (`desktop-tauri/`) spawns the FastAPI backend as a local Python subprocess on launch and the frontend talks to it over HTTP (default port 8000). Tauri commands are reserved for shell-only concerns (file dialogs, system tray, updater); all conversation, Tool, Agent, and Provider logic lives in the backend, not in Rust.

We picked this over moving the engine into Rust/Tauri commands because (a) the same backend is also the remote-access server reachable through Cloudflare Tunnel — one code path serves desktop and mobile web; (b) Python is the pragmatic language for the LLM/Provider ecosystem; (c) the subprocess boundary lets us ship a packaged backend binary that can be tested headless without the desktop shell.
