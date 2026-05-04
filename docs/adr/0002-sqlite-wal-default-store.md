# SQLite with WAL is the default store; PostgreSQL is optional

OpenYak persists Projects, Sessions, Messages, and Parts in SQLite with WAL mode and foreign keys enforced (`backend/app/storage/`). PostgreSQL is configurable for self-hosted or shared deployments but is not the default.

OpenYak is local-first — the user's data lives on their machine, with no server. SQLite ships with Python, runs as a single file inside the app's data directory, and WAL gives us concurrent reader/writer behavior good enough for one user with multiple Sessions and a streaming generation in flight. PostgreSQL stays optional so power users running a shared deployment can point at a real database without forking the data layer.
