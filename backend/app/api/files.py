"""File API — upload, browse (native dialog), and attach-by-path."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
import mimetypes
import os
import platform
import subprocess
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Request, UploadFile
from pydantic import BaseModel

from app.utils.id import generate_ulid

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Telemetry — ADR-0010
# ---------------------------------------------------------------------------

def _log_browse_telemetry(
    event: str,
    request: Request | None,
    outcome: str,
    *,
    paths_count: int | None = None,
    error: str | None = None,
) -> None:
    """Emit one structured log line per /files/browse* hit.

    Per ADR-0010 the backend native-dialog code paths may be vestigial —
    the frontend (`upload.ts`) prefers Tauri's plugin-dialog and only falls
    back to these endpoints on import failure. After one release of this
    signal we decide between extraction and deletion based on hit rate.
    """
    ua = request.headers.get("user-agent", "") if request is not None else ""
    caller = "tauri" if "tauri" in ua.lower() else "browser"
    fields = [
        f"event={event}",
        f"outcome={outcome}",
        f"caller={caller}",
        f"server={platform.system()}",
    ]
    if paths_count is not None:
        fields.append(f"paths={paths_count}")
    if error:
        fields.append(f"error={error[:120]!r}")
    logger.info("telemetry.files_browse %s", " ".join(fields))

# Upload destination — relative to backend working directory
UPLOAD_DIR = Path("data/uploads")

# In-memory hash → path index for deduplication of uploaded files
_hash_index: dict[str, Path] = {}


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class BrowseRequest(BaseModel):
    multiple: bool = True
    title: str = "Select files"


class BrowseDirectoryRequest(BaseModel):
    title: str = "Select workspace directory"


class AttachRequest(BaseModel):
    paths: list[str]


class FileMetadata(BaseModel):
    file_id: str
    name: str
    path: str
    size: int
    mime_type: str
    source: Literal["referenced", "uploaded"] = "uploaded"
    content_hash: str | None = None


# ---------------------------------------------------------------------------
# Hash-index management
# ---------------------------------------------------------------------------

def rebuild_hash_index() -> None:
    """Scan data/uploads and rebuild the dedup hash index."""
    _hash_index.clear()
    if not UPLOAD_DIR.exists():
        return
    for f in UPLOAD_DIR.iterdir():
        if f.is_file():
            try:
                digest = hashlib.sha256(f.read_bytes()).hexdigest()
                _hash_index[digest] = f
            except OSError:
                pass
    logger.info("Upload hash index rebuilt: %d entries", len(_hash_index))


def remove_from_hash_index(content_hash: str | None) -> None:
    """Remove a hash entry (called when an uploaded file is deleted)."""
    if content_hash and content_hash in _hash_index:
        del _hash_index[content_hash]


# ---------------------------------------------------------------------------
# Native file dialog (platform-specific)
# ---------------------------------------------------------------------------

async def _open_native_file_dialog(
    multiple: bool = True,
    title: str = "Select files",
    *,
    request: Request | None = None,
) -> list[str]:
    """Open an OS-native file dialog and return selected paths.

    Uses platform-specific subprocess calls:
    - Windows: PowerShell + System.Windows.Forms.OpenFileDialog
    - macOS: osascript (AppleScript)
    - Linux: zenity
    """
    system = platform.system()

    try:
        if system == "Windows":
            return await _dialog_windows(multiple, title)
        elif system == "Darwin":
            return await _dialog_macos(multiple, title)
        else:
            return await _dialog_linux(multiple, title)
    except Exception as e:
        logger.warning("Native file dialog failed: %s", e)
        _log_browse_telemetry("files_browse", request, "error", error=str(e))
        return []


async def _dialog_windows(multiple: bool, title: str) -> list[str]:
    """Windows: PowerShell + WinForms OpenFileDialog.

    Uses -STA for WinForms compatibility and a TopMost owner form
    so the dialog appears in front of the browser window.
    Uses subprocess.run in a thread because Windows SelectorEventLoop
    does not support asyncio.create_subprocess_exec.
    """
    multiselect = "$true" if multiple else "$false"
    script = (
        # Force UTF-8 output so non-ASCII paths survive decoding
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;"
        # Enable DPI awareness BEFORE loading WinForms — prevents blurry dialog on high-DPI screens
        "Add-Type -TypeDefinition '"
        "using System.Runtime.InteropServices; "
        "public class DpiHelper { "
        "[DllImport(\"user32.dll\")] "
        "public static extern bool SetProcessDPIAware(); "
        "}';"
        "[void][DpiHelper]::SetProcessDPIAware();"
        "Add-Type -AssemblyName System.Windows.Forms;"
        "[System.Windows.Forms.Application]::EnableVisualStyles();"
        "$f = New-Object System.Windows.Forms.Form;"
        "$f.TopMost = $true;"
        "$d = New-Object System.Windows.Forms.OpenFileDialog;"
        f"$d.Title = '{title}';"
        f"$d.Multiselect = {multiselect};"
        "$d.Filter = 'All files (*.*)|*.*';"
        "if ($d.ShowDialog($f) -eq 'OK') {"
        "  $d.FileNames -join '|'"
        "}"
        "$f.Dispose()"
    )

    def _run() -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-Command", script],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=300,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )

    result = await asyncio.to_thread(_run)
    raw = result.stdout.decode("utf-8", errors="replace").strip()
    stderr = result.stderr.decode("utf-8", errors="replace").strip()
    if stderr:
        logger.warning("PowerShell dialog stderr: %s", stderr)
    if result.returncode != 0:
        logger.warning("PowerShell dialog exited with code %d", result.returncode)
    logger.info("PowerShell dialog raw stdout: %r", raw[:500])
    if not raw:
        return []
    paths = [p for p in raw.split("|") if p.strip()]
    # Log each path for debugging
    for p in paths:
        fp = Path(p)
        logger.info("Browse path: %r exists=%s is_file=%s", p, fp.exists(), fp.is_file())
    return paths


async def _dialog_macos(multiple: bool, title: str) -> list[str]:
    multi_clause = " with multiple selections allowed" if multiple else ""
    script = f'choose file with prompt "{title}"{multi_clause}'

    def _run() -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(
            ["osascript", "-e", script],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=300,
        )

    result = await asyncio.to_thread(_run)
    raw = result.stdout.decode("utf-8", errors="replace").strip()
    if not raw:
        return []
    # osascript returns "alias Macintosh HD:Users:..." format
    paths = []
    for item in raw.split(", "):
        item = item.strip()
        if item.startswith("alias "):
            item = item[6:]
        # Convert colon-separated path to POSIX
        parts = item.split(":")
        if len(parts) > 1:
            paths.append("/" + "/".join(parts[1:]))
        else:
            paths.append(item)
    return paths


async def _dialog_linux(multiple: bool, title: str) -> list[str]:
    args = ["zenity", "--file-selection", f"--title={title}"]
    if multiple:
        args.append("--multiple")
        args.append("--separator=|")

    def _run() -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=300,
        )

    result = await asyncio.to_thread(_run)
    stdout = result.stdout
    raw = stdout.decode("utf-8", errors="replace").strip()
    if not raw:
        return []
    return [p for p in raw.split("|") if p.strip()]


# ---------------------------------------------------------------------------
# Native directory dialog (platform-specific)
# ---------------------------------------------------------------------------

async def _open_native_directory_dialog(
    title: str = "Select directory",
    *,
    request: Request | None = None,
) -> str | None:
    """Open an OS-native folder picker and return the selected path."""
    system = platform.system()
    try:
        if system == "Windows":
            return await _dir_dialog_windows(title)
        elif system == "Darwin":
            return await _dir_dialog_macos(title)
        else:
            return await _dir_dialog_linux(title)
    except Exception as e:
        logger.warning("Native directory dialog failed: %s", e)
        _log_browse_telemetry("files_browse_directory", request, "error", error=str(e))
        return None


async def _dir_dialog_windows(title: str) -> str | None:
    # COM interop class for IFileOpenDialog with FOS_PICKFOLDERS.
    # This produces the modern Explorer-style folder picker (breadcrumb
    # nav, search, favorites) instead of the legacy XP tree-view dialog.
    # All IFileDialog vtable slots must be declared in order even if unused.
    csharp = (
        "using System; "
        "using System.Runtime.InteropServices; "
        "[Flags] public enum FOS : uint { "
        "  PICKFOLDERS = 0x20, FORCEFILESYSTEM = 0x40, PATHMUSTEXIST = 0x800 "
        "} "
        "[ComImport, Guid(\"43826D1E-E718-42EE-BC55-A1E261C37BFE\"), "
        " InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] "
        "public interface IShellItem { "
        "  void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv); "
        "  void GetParent(out IShellItem ppsi); "
        "  void GetDisplayName(uint sigdnName, "
        "    [MarshalAs(UnmanagedType.LPWStr)] out string ppszName); "
        "  void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs); "
        "  void Compare(IShellItem psi, uint hint, out int piOrder); "
        "} "
        "[ComImport, Guid(\"42f85136-db7e-439c-85f1-e4075d135fc8\"), "
        " InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] "
        "public interface IFileDialog { "
        "  [PreserveSig] int Show(IntPtr parent); "
        "  void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec); "
        "  void SetFileTypeIndex(uint iFileType); "
        "  void GetFileTypeIndex(out uint piFileType); "
        "  void Advise(IntPtr pfde, out uint pdwCookie); "
        "  void Unadvise(uint dwCookie); "
        "  void SetOptions(FOS fos); "
        "  void GetOptions(out FOS pfos); "
        "  void SetDefaultFolder(IShellItem psi); "
        "  void SetFolder(IShellItem psi); "
        "  void GetFolder(out IShellItem ppsi); "
        "  void GetCurrentSelection(out IShellItem ppsi); "
        "  void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName); "
        "  void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName); "
        "  void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle); "
        "  void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText); "
        "  void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel); "
        "  void GetResult(out IShellItem ppsi); "
        "  void AddPlace(IShellItem psi, int fdap); "
        "  void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension); "
        "  void Close(int hr); "
        "  void SetClientGuid(ref Guid guid); "
        "  void ClearClientData(); "
        "  void SetFilter(IntPtr pFilter); "
        "} "
        "[ComImport, Guid(\"DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7\")] "
        "public class FileOpenDialog {} "
        "public class FolderPicker { "
        "  public static string Show(string title, IntPtr hwnd) { "
        "    IFileDialog dlg = (IFileDialog)new FileOpenDialog(); "
        "    try { "
        "      dlg.SetOptions(FOS.PICKFOLDERS | FOS.FORCEFILESYSTEM | FOS.PATHMUSTEXIST); "
        "      dlg.SetTitle(title); "
        "      if (dlg.Show(hwnd) != 0) return null; "
        "      IShellItem item; dlg.GetResult(out item); "
        "      string path; item.GetDisplayName(0x80058000, out path); "
        "      return path; "
        "    } catch { return null; } "
        "    finally { Marshal.ReleaseComObject(dlg); } "
        "  } "
        "} "
    )
    script = (
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;"
        "Add-Type -TypeDefinition '"
        "using System.Runtime.InteropServices; "
        "public class DpiHelper { "
        "[DllImport(\"user32.dll\")] "
        "public static extern bool SetProcessDPIAware(); "
        "}';"
        "[void][DpiHelper]::SetProcessDPIAware();"
        "Add-Type -AssemblyName System.Windows.Forms;"
        "[System.Windows.Forms.Application]::EnableVisualStyles();"
        f"Add-Type -TypeDefinition '{csharp}';"
        "$f = New-Object System.Windows.Forms.Form;"
        "$f.TopMost = $true;"
        f"$result = [FolderPicker]::Show('{title}', $f.Handle);"
        "if ($result) { $result }"
        "$f.Dispose()"
    )

    def _run() -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-Command", script],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=300,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )

    result = await asyncio.to_thread(_run)
    raw = result.stdout.decode("utf-8", errors="replace").strip()
    return raw if raw else None


async def _dir_dialog_macos(title: str) -> str | None:
    script = f'choose folder with prompt "{title}"'

    def _run() -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(
            ["osascript", "-e", script],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=300,
        )

    result = await asyncio.to_thread(_run)
    raw = result.stdout.decode("utf-8", errors="replace").strip()
    if not raw:
        return None
    if raw.startswith("alias "):
        raw = raw[6:]
    parts = raw.split(":")
    if len(parts) > 1:
        return "/" + "/".join(parts[1:])
    return raw


async def _dir_dialog_linux(title: str) -> str | None:
    def _run() -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(
            ["zenity", "--file-selection", "--directory", f"--title={title}"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=300,
        )

    result = await asyncio.to_thread(_run)
    raw = result.stdout.decode("utf-8", errors="replace").strip()
    return raw if raw else None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _file_metadata(path: Path, *, source: str, content_hash: str | None = None) -> FileMetadata:
    """Build FileMetadata from a resolved file path."""
    mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileMetadata(
        file_id=generate_ulid(),
        name=path.name,
        path=str(path.resolve()),
        size=path.stat().st_size,
        mime_type=mime_type,
        source=source,
        content_hash=content_hash,
    )


def _path_metadata(path: Path, *, source: str, content_hash: str | None = None) -> FileMetadata:
    """Build attachment metadata for a file or directory path."""
    if path.is_dir():
        resolved = path.resolve()
        return FileMetadata(
            file_id=generate_ulid(),
            name=resolved.name or str(resolved),
            path=str(resolved),
            size=0,
            mime_type="inode/directory",
            source=source,
            content_hash=content_hash,
        )
    return _file_metadata(path, source=source, content_hash=content_hash)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

class FileContentRequest(BaseModel):
    path: str
    workspace: str | None = None  # Resolve relative paths against this directory


def _resolve_requested_file_path(path: str, workspace: str | None = None) -> Path:
    """Resolve a requested file path for preview/open operations.

    Relative paths are resolved against the active workspace when present.
    In unrestricted sessions, they fall back to the backend process cwd so
    references like ``backend/app/main.py`` remain openable.
    """
    file_path = Path(path)
    if file_path.is_absolute():
        return file_path

    if workspace:
        return (Path(workspace) / file_path).resolve()

    return (Path.cwd() / file_path).resolve()


@router.post("/files/content")
async def get_file_content(body: FileContentRequest) -> dict[str, Any]:
    """Read a file from disk and return its content for artifact preview."""
    from fastapi import HTTPException

    file_path = _resolve_requested_file_path(body.path, body.workspace)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {body.path}")
    if not file_path.is_file():
        raise HTTPException(status_code=400, detail=f"Not a file: {body.path}")

    try:
        content = file_path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail=f"Binary file cannot be previewed: {body.path}")

    mime_type = mimetypes.guess_type(file_path.name)[0] or "text/plain"
    return {
        "content": content,
        "path": str(file_path.resolve()),
        "name": file_path.name,
        "mime_type": mime_type,
        "size": file_path.stat().st_size,
    }


@router.post("/files/content-binary")
async def get_file_content_binary(body: FileContentRequest) -> dict[str, Any]:
    """Read a binary file from disk and return base64-encoded content.

    Used for .docx, .xlsx, and other binary formats that need
    client-side rendering (e.g. docx-preview, SheetJS).
    """
    from fastapi import HTTPException

    file_path = _resolve_requested_file_path(body.path, body.workspace)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {body.path}")
    if not file_path.is_file():
        raise HTTPException(status_code=400, detail=f"Not a file: {body.path}")

    MAX_SIZE = 50 * 1024 * 1024  # 50 MB
    size = file_path.stat().st_size
    if size > MAX_SIZE:
        raise HTTPException(status_code=400, detail=f"File too large ({size} bytes, max {MAX_SIZE})")

    content_b64 = base64.b64encode(file_path.read_bytes()).decode("ascii")
    mime_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    return {
        "content_base64": content_b64,
        "name": file_path.name,
        "path": str(file_path.resolve()),
        "mime_type": mime_type,
        "size": size,
    }


@router.post("/files/open-system")
async def open_with_system(body: FileContentRequest) -> dict[str, str]:
    """Open a file with the OS default application."""
    from fastapi import HTTPException

    file_path = _resolve_requested_file_path(body.path, body.workspace)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {body.path}")

    system = platform.system()
    try:
        if system == "Windows":
            os.startfile(str(file_path))  # type: ignore[attr-defined]
        elif system == "Darwin":
            subprocess.Popen(["open", str(file_path)])
        else:
            subprocess.Popen(["xdg-open", str(file_path)])
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to open file: {e}")

    return {"status": "ok"}


@router.post("/files/browse-directory")
async def browse_directory(
    request: Request,
    body: BrowseDirectoryRequest | None = None,
) -> dict[str, str | None]:
    """Open native directory picker dialog. Returns selected path or null."""
    req = body or BrowseDirectoryRequest()
    path = await _open_native_directory_dialog(title=req.title, request=request)
    _log_browse_telemetry(
        "files_browse_directory",
        request,
        "success" if path else "cancel",
        paths_count=1 if path else 0,
    )
    return {"path": path}


class ListDirectoryRequest(BaseModel):
    path: str | None = None  # None = user home directory


@router.post("/files/list-directory")
async def list_directory(body: ListDirectoryRequest | None = None) -> dict[str, Any]:
    """List subdirectories of a given path for remote directory browsing.

    Returns the resolved parent path and a list of child directories.
    Hidden directories (starting with .) are excluded by default.
    """
    req = body or ListDirectoryRequest()
    target = Path(req.path) if req.path else Path.home()
    target = target.resolve()

    if not target.is_dir():
        return {"path": str(target), "parent": str(target.parent), "dirs": []}

    dirs: list[dict[str, str]] = []
    try:
        with os.scandir(target) as entries:
            for entry in entries:
                try:
                    if entry.is_dir() and not entry.name.startswith("."):
                        dirs.append({"name": entry.name, "path": entry.path})
                except (PermissionError, OSError):
                    continue
    except (PermissionError, OSError):
        pass

    dirs.sort(key=lambda d: d["name"].lower())

    return {
        "path": str(target),
        "parent": str(target.parent) if target.parent != target else None,
        "dirs": dirs,
    }


@router.post("/files/browse")
async def browse_files(
    request: Request,
    body: BrowseRequest | None = None,
) -> list[dict[str, Any]]:
    """Open native file dialog and return metadata for selected files.

    No files are copied — paths reference the originals.
    """
    req = body or BrowseRequest()
    paths = await _open_native_file_dialog(
        multiple=req.multiple, title=req.title, request=request
    )

    results = []
    for p in paths:
        fp = Path(p)
        if fp.is_file():
            results.append(_file_metadata(fp, source="referenced").model_dump())

    _log_browse_telemetry(
        "files_browse",
        request,
        "success" if results else "cancel",
        paths_count=len(results),
    )
    return results


@router.post("/files/attach")
async def attach_by_path(body: AttachRequest) -> list[dict[str, Any]]:
    """Attach files or directories by explicit paths. No copying.

    Validates that each path exists and references it in-place.
    """
    results = []
    for p in body.paths:
        fp = Path(p)
        if fp.exists() and (fp.is_file() or fp.is_dir()):
            results.append(_path_metadata(fp, source="referenced").model_dump())
        else:
            logger.warning("Attach path not found or not attachable: %s", p)
    return results


class IngestRequest(BaseModel):
    """Ingest files into FTS index for a session."""
    session_id: str
    workspace: str
    paths: list[str]


@router.post("/files/ingest")
async def ingest_files(request: Request, body: IngestRequest) -> dict[str, Any]:
    """Ingest attached files into the FTS index for an existing session.

    Called by the frontend immediately after attaching files to a session
    that already exists, so they are indexed without waiting for the next
    message to be sent.
    """
    manager = getattr(request.app.state, "index_manager", None)
    if manager is None:
        return {"ingested": 0, "message": "FTS not enabled"}

    if not body.workspace or not body.session_id:
        return {"ingested": 0, "message": "workspace and session_id required"}

    try:
        await manager.ensure_index(body.workspace, body.session_id)

        ingested = 0
        for p in body.paths:
            fp = Path(p)
            if fp.is_file():
                try:
                    await manager.ingest_file(body.workspace, p)
                    ingested += 1
                except Exception as e:
                    logger.warning("FTS ingest failed for %s: %s", p, e)

        return {"ingested": ingested, "message": f"Ingested {ingested} file(s)"}
    except Exception as e:
        logger.error("FTS ingest error: %s", e)
        return {"ingested": 0, "message": str(e)}


@router.post("/files/upload")
async def upload_file(file: UploadFile) -> dict:
    """Upload a file (for browser drag-drop where path is unavailable).

    Includes SHA-256 deduplication: if the same content was already
    uploaded, the existing file is reused.
    """
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

    content = await file.read()
    digest = hashlib.sha256(content).hexdigest()

    # Check dedup index
    existing = _hash_index.get(digest)
    if existing and existing.exists():
        meta = _file_metadata(existing, source="uploaded", content_hash=digest)
        return meta.model_dump()

    # Save new file
    file_id = generate_ulid()
    original_name = file.filename or "untitled"
    safe_name = Path(original_name).name
    dest = UPLOAD_DIR / f"{file_id}_{safe_name}"
    dest.write_bytes(content)

    # Update index
    _hash_index[digest] = dest

    mime_type = file.content_type or mimetypes.guess_type(safe_name)[0] or "application/octet-stream"

    return FileMetadata(
        file_id=file_id,
        name=safe_name,
        path=str(dest.resolve()),
        size=len(content),
        mime_type=mime_type,
        source="uploaded",
        content_hash=digest,
    ).model_dump()


# ---------------------------------------------------------------------------
# File search (for @mention autocomplete)
# ---------------------------------------------------------------------------

# Directories to skip when walking workspace for file search
_IGNORED_DIRS = frozenset({
    ".git", "node_modules", "__pycache__", ".next", "dist", "build",
    ".venv", "venv", ".tox", ".mypy_cache", "target", ".turbo",
    ".cache", ".parcel-cache", ".svelte-kit", ".nuxt", ".output",
    "coverage", ".pytest_cache", ".ruff_cache",
})


class FileSearchRequest(BaseModel):
    directory: str
    query: str = ""
    limit: int = 50


class FileSearchResultItem(BaseModel):
    name: str
    relative_path: str
    absolute_path: str


def _walk_files(root: Path, query_lower: str, limit: int) -> list[FileSearchResultItem]:
    """Recursively walk *root*, returning files whose relative path contains *query_lower*."""
    results: list[FileSearchResultItem] = []

    def _scan(directory: Path, rel_prefix: str) -> None:
        if len(results) >= limit * 3:  # collect extra for sorting, cap for perf
            return
        try:
            entries = sorted(os.scandir(directory), key=lambda e: e.name.lower())
        except (PermissionError, OSError):
            return
        for entry in entries:
            if entry.is_dir(follow_symlinks=False):
                if entry.name in _IGNORED_DIRS or entry.name.startswith("."):
                    continue
                _scan(entry.path, f"{rel_prefix}{entry.name}/")
            elif entry.is_file(follow_symlinks=False):
                rel_path = f"{rel_prefix}{entry.name}"
                if not query_lower or query_lower in rel_path.lower():
                    results.append(FileSearchResultItem(
                        name=entry.name,
                        relative_path=rel_path,
                        absolute_path=str(Path(entry.path).resolve()),
                    ))

    _scan(root, "")

    if not query_lower:
        # No query — return shortest paths first
        results.sort(key=lambda r: (len(r.relative_path), r.relative_path.lower()))
    else:
        # Sort: exact filename match first, then shortest path
        def _sort_key(r: FileSearchResultItem) -> tuple[int, int, str]:
            name_lower = r.name.lower()
            exact = 0 if name_lower == query_lower else (1 if query_lower in name_lower else 2)
            return (exact, len(r.relative_path), r.relative_path.lower())
        results.sort(key=_sort_key)

    return results[:limit]


@router.post("/files/search")
async def search_files(body: FileSearchRequest) -> list[dict[str, str]]:
    """Search for files in a workspace directory. Used for @mention autocomplete."""
    root = Path(body.directory)
    if not root.is_dir():
        return []

    query_lower = body.query.strip().lower()
    limit = min(body.limit, 100)  # hard cap

    results = await asyncio.to_thread(_walk_files, root, query_lower, limit)
    return [r.model_dump() for r in results]
