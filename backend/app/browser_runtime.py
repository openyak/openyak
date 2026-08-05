"""Managed Browser capability runtime built on Playwright.

The profile, tabs, DOM references and screenshots belong to OpenYak rather
than to the user's normal Chrome profile.  This is intentionally separate
from native Computer Use and from a future signed-in Chrome extension surface.
"""

from __future__ import annotations

import asyncio
import platform
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class BrowserTab:
    id: str
    url: str
    title: str


class PlaywrightBrowserRuntime:
    def __init__(self, profile_dir: Path | None = None) -> None:
        self._profile_dir = profile_dir or Path.home() / ".openyak" / "browser-profile"
        self._playwright: Any = None
        self._context: Any = None
        self._tabs: dict[str, Any] = {}
        self._page_ids: dict[int, str] = {}
        self._next_tab = 1
        self._console_logs: dict[str, list[dict[str, Any]]] = {}
        self._network_log: dict[str, list[dict[str, Any]]] = {}
        self._dialogs: dict[str, Any] = {}
        self._dialog_events: dict[str, asyncio.Event] = {}
        self._dialog_tasks: dict[str, asyncio.Task[Any]] = {}
        self._clipboard_text = ""
        self._control_owner = "agent"
        self._agent_control = asyncio.Event()
        self._agent_control.set()

    @property
    def control_owner(self) -> str:
        return self._control_owner

    async def take_over(self) -> None:
        """Pause future Agent interactions while the user controls the page."""
        self._control_owner = "user"
        self._agent_control.clear()

    async def resume_agent(self) -> None:
        """Return the managed Browser to the Agent and release waiting actions."""
        self._control_owner = "agent"
        self._agent_control.set()

    async def wait_for_agent_control(self) -> None:
        await self._agent_control.wait()

    async def _start(self) -> None:
        if self._context is not None:
            return
        try:
            from playwright.async_api import async_playwright
        except Exception as exc:
            raise RuntimeError(
                "Managed Browser runtime is missing. Reinstall OpenYak to restore Playwright."
            ) from exc
        self._profile_dir.mkdir(parents=True, exist_ok=True)
        self._playwright = await async_playwright().start()
        channels = ["chrome", "msedge"] if platform.system() == "Windows" else ["chrome"]
        last_error: Exception | None = None
        for channel in channels:
            try:
                self._context = await self._playwright.chromium.launch_persistent_context(
                    str(self._profile_dir),
                    channel=channel,
                    headless=False,
                    no_viewport=True,
                    args=["--disable-blink-features=AutomationControlled"],
                )
                break
            except Exception as exc:
                last_error = exc
        if self._context is None:
            await self._playwright.stop()
            self._playwright = None
            raise RuntimeError(
                "OpenYak Managed Browser requires Google Chrome on macOS or Chrome/Edge on Windows"
            ) from last_error
        for page in self._context.pages:
            self._register(page)

    def _register(self, page: Any) -> str:
        identity = id(page)
        existing = self._page_ids.get(identity)
        if existing:
            return existing
        tab_id = f"tab-{self._next_tab}"
        self._next_tab += 1
        self._tabs[tab_id] = page
        self._page_ids[identity] = tab_id
        self._console_logs[tab_id] = []
        self._network_log[tab_id] = []
        self._dialog_events[tab_id] = asyncio.Event()
        page.on("close", lambda: self._remove_page(page))
        page.on("console", lambda message: self._record_console(tab_id, message))
        page.on("request", lambda request: self._record_request(tab_id, request))
        page.on("response", lambda response: self._record_response(tab_id, response))
        page.on("dialog", lambda dialog: self._record_dialog(tab_id, dialog))
        return tab_id

    def _remove_page(self, page: Any) -> None:
        tab_id = self._page_ids.pop(id(page), None)
        if tab_id:
            self._tabs.pop(tab_id, None)
            self._console_logs.pop(tab_id, None)
            self._network_log.pop(tab_id, None)
            self._dialogs.pop(tab_id, None)
            self._dialog_events.pop(tab_id, None)
            task = self._dialog_tasks.pop(tab_id, None)
            if task is not None:
                task.cancel()

    def _record_dialog(self, tab_id: str, dialog: Any) -> None:
        self._dialogs[tab_id] = dialog
        self._dialog_events.setdefault(tab_id, asyncio.Event()).set()

    def _record_console(self, tab_id: str, message: Any) -> None:
        entries = self._console_logs.setdefault(tab_id, [])
        entries.append({
            "type": str(message.type),
            "text": str(message.text)[:4_000],
            "location": dict(message.location or {}),
            "timestamp": time.time(),
        })
        del entries[:-500]

    def _record_request(self, tab_id: str, request: Any) -> None:
        entries = self._network_log.setdefault(tab_id, [])
        entries.append({
            "kind": "request",
            "method": str(request.method),
            "url": str(request.url)[:4_000],
            "resource_type": str(request.resource_type),
            "timestamp": time.time(),
        })
        del entries[:-1_000]

    def _record_response(self, tab_id: str, response: Any) -> None:
        entries = self._network_log.setdefault(tab_id, [])
        entries.append({
            "kind": "response",
            "status": int(response.status),
            "url": str(response.url)[:4_000],
            "timestamp": time.time(),
        })
        del entries[:-1_000]

    async def _page(self, tab_id: str | None) -> tuple[str, Any]:
        await self._start()
        if tab_id:
            page = self._tabs.get(tab_id)
            if page is None or page.is_closed():
                raise ValueError(f"Unknown or closed browser tab: {tab_id}")
            return tab_id, page
        for candidate_id, page in reversed(list(self._tabs.items())):
            if not page.is_closed():
                return candidate_id, page
        page = await self._context.new_page()
        return self._register(page), page

    async def list_tabs(self) -> list[BrowserTab]:
        await self._start()
        tabs: list[BrowserTab] = []
        for tab_id, page in list(self._tabs.items()):
            if page.is_closed():
                self._remove_page(page)
                continue
            tabs.append(BrowserTab(tab_id, page.url, await page.title()))
        return tabs

    async def open(self, url: str) -> str:
        await self._start()
        page = await self._context.new_page()
        tab_id = self._register(page)
        await page.goto(url, wait_until="domcontentloaded", timeout=30_000)
        return tab_id

    async def new_tab(self) -> str:
        await self._start()
        page = await self._context.new_page()
        return self._register(page)

    async def navigate(self, tab_id: str, url: str) -> None:
        _, page = await self._page(tab_id)
        await page.goto(url, wait_until="domcontentloaded", timeout=30_000)

    async def current_url(self, tab_id: str | None) -> str:
        _, page = await self._page(tab_id)
        return str(page.url)

    async def snapshot(self, tab_id: str | None, *, include_screenshot: bool = True) -> dict[str, Any]:
        resolved_id, page = await self._page(tab_id)
        await self._settle(page)
        snapshot = {"elements": [], "text": "", "frames": []}
        text_parts: list[str] = []
        for frame_index, frame in enumerate(page.frames):
            try:
                frame_snapshot = await frame.evaluate(
                    _SNAPSHOT_SCRIPT, f"f{frame_index}-"
                )
            except Exception:
                continue
            for element in frame_snapshot.get("elements", []):
                element["frame_url"] = frame.url
                element["frame_index"] = frame_index
            snapshot["elements"].extend(frame_snapshot.get("elements", []))
            frame_text = str(frame_snapshot.get("text", ""))
            if frame_text:
                text_parts.append(frame_text)
            snapshot["frames"].append({
                "index": frame_index,
                "url": frame.url,
                "name": frame.name,
            })
        snapshot["elements"] = snapshot["elements"][:500]
        snapshot["text"] = "\n\n".join(text_parts)[:20_000]
        snapshot["tab_id"] = resolved_id
        snapshot["url"] = page.url
        snapshot["title"] = await page.title()
        snapshot["tabs"] = [tab.__dict__ for tab in await self.list_tabs()]
        snapshot["viewport"] = await page.evaluate(
            "() => ({width: window.innerWidth, height: window.innerHeight})"
        )
        if include_screenshot:
            snapshot["screenshot"] = await page.screenshot(type="png")
        return snapshot

    async def observe(self, tab_id: str | None) -> dict[str, Any]:
        """Return a low-latency visual frame for the user-facing workspace."""
        resolved_id, page = await self._page(tab_id)
        viewport = await page.evaluate(
            "() => ({width: window.innerWidth, height: window.innerHeight})"
        )
        return {
            "tab_id": resolved_id,
            "url": str(page.url),
            "title": await page.title(),
            "viewport": viewport,
            "screenshot": await page.screenshot(type="png"),
        }

    async def _settle(self, page: Any, *, timeout_ms: int = 5_000) -> None:
        """Wait for navigation and visible DOM to become quiet without hanging on SPAs."""
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=min(timeout_ms, 2_000))
        except Exception:
            pass
        deadline = time.monotonic() + timeout_ms / 1_000
        previous = None
        unchanged_since = time.monotonic()
        while time.monotonic() < deadline:
            try:
                signature = await page.evaluate(_DOM_STABILITY_SCRIPT)
            except Exception:
                await page.wait_for_timeout(150)
                continue
            now = time.monotonic()
            busy = not str(signature).startswith("0:")
            if signature != previous or busy:
                previous = signature
                unchanged_since = now
            elif now - unchanged_since >= 0.45:
                return
            await page.wait_for_timeout(150)

    async def _locator_by_ref(self, page: Any, ref: str) -> Any:
        selector = f'[data-openyak-ref="{_css_escape(ref)}"]'
        for frame in page.frames:
            locator = frame.locator(selector)
            if await locator.count():
                return locator.first
        raise ValueError(f"Unknown or stale browser element ref: {ref}; take a new snapshot")

    async def inspect_ref(self, tab_id: str, ref: str) -> dict[str, Any]:
        _, page = await self._page(tab_id)
        locator = await self._locator_by_ref(page, ref)
        return await locator.evaluate(
            """element => ({
              role: element.getAttribute('role') || element.tagName.toLowerCase(),
              name: element.getAttribute('aria-label') || element.innerText ||
                element.getAttribute('placeholder') || element.getAttribute('title') || '',
              input_type: element instanceof HTMLInputElement ? element.type : '',
              autocomplete: element.getAttribute('autocomplete') || '',
            })"""
        )

    async def click(self, tab_id: str, ref: str, *, button: str = "left", click_count: int = 1) -> None:
        _, page = await self._page(tab_id)
        locator = await self._locator_by_ref(page, ref)
        await self._run_maybe_dialog_action(
            tab_id,
            locator.click(
                button=button,
                click_count=max(1, min(2, click_count)),
                timeout=10_000,
            ),
        )

    async def _run_maybe_dialog_action(self, tab_id: str, awaitable: Any) -> None:
        event = self._dialog_events.setdefault(tab_id, asyncio.Event())
        event.clear()
        action_task = asyncio.create_task(awaitable)
        dialog_task = asyncio.create_task(event.wait())
        done, _ = await asyncio.wait(
            {action_task, dialog_task}, return_when=asyncio.FIRST_COMPLETED
        )
        if action_task in done:
            dialog_task.cancel()
            await action_task
            return
        self._dialog_tasks[tab_id] = action_task
        dialog_task.cancel()

    async def fill(self, tab_id: str, ref: str, value: str) -> None:
        _, page = await self._page(tab_id)
        await (await self._locator_by_ref(page, ref)).fill(value, timeout=10_000)

    async def type_text(self, tab_id: str, ref: str, text: str) -> None:
        _, page = await self._page(tab_id)
        await (await self._locator_by_ref(page, ref)).press_sequentially(
            text, delay=10, timeout=10_000
        )

    async def manual_type(self, tab_id: str, text: str) -> None:
        _, page = await self._page(tab_id)
        await page.keyboard.type(text, delay=10)

    async def press(self, tab_id: str, key: str, ref: str | None = None) -> None:
        _, page = await self._page(tab_id)
        target = await self._locator_by_ref(page, ref) if ref else page
        await target.press(_normalize_key(key), timeout=10_000)

    async def select_option(self, tab_id: str, ref: str, value: str) -> None:
        _, page = await self._page(tab_id)
        await (await self._locator_by_ref(page, ref)).select_option(value)

    async def set_checked(self, tab_id: str, ref: str, checked: bool) -> None:
        _, page = await self._page(tab_id)
        await (await self._locator_by_ref(page, ref)).set_checked(checked, timeout=10_000)

    async def scroll(self, tab_id: str, delta_y: int, ref: str | None = None) -> None:
        _, page = await self._page(tab_id)
        if ref:
            await (await self._locator_by_ref(page, ref)).evaluate(
                "(element, delta) => element.scrollBy(0, delta)", delta_y
            )
        else:
            await page.mouse.wheel(0, delta_y)

    async def coordinate_click(
        self,
        tab_id: str,
        x: float,
        y: float,
        *,
        button: str = "left",
        click_count: int = 1,
    ) -> None:
        _, page = await self._page(tab_id)
        await self._require_viewport_point(page, x, y)
        await page.mouse.click(x, y, button=button, click_count=click_count)

    async def drag(
        self,
        tab_id: str,
        from_x: float,
        from_y: float,
        to_x: float,
        to_y: float,
    ) -> None:
        _, page = await self._page(tab_id)
        await self._require_viewport_point(page, from_x, from_y)
        await self._require_viewport_point(page, to_x, to_y)
        await page.mouse.move(from_x, from_y)
        await page.mouse.down()
        await page.mouse.move(to_x, to_y, steps=12)
        await page.mouse.up()

    async def hover(self, tab_id: str, x: float, y: float) -> None:
        _, page = await self._page(tab_id)
        await self._require_viewport_point(page, x, y)
        await page.mouse.move(x, y)

    async def _require_viewport_point(self, page: Any, x: float, y: float) -> None:
        viewport = await page.evaluate("() => [window.innerWidth, window.innerHeight]")
        if not (0 <= x <= float(viewport[0]) and 0 <= y <= float(viewport[1])):
            raise ValueError("Browser coordinate is outside the current viewport")

    async def clipboard(self, tab_id: str, *, text: str | None = None) -> str:
        await self._page(tab_id)
        if text is not None:
            self._clipboard_text = text
        return self._clipboard_text

    async def logs(self, tab_id: str, *, kind: str = "console", limit: int = 200) -> list[dict[str, Any]]:
        await self._page(tab_id)
        source = self._console_logs if kind == "console" else self._network_log
        return list(source.get(tab_id, []))[-max(1, min(limit, 500)):]

    async def dialog(self, tab_id: str, *, response: str, text: str = "") -> dict[str, Any]:
        await self._page(tab_id)
        dialog = self._dialogs.get(tab_id)
        if dialog is None:
            raise ValueError("The tab has no active JavaScript dialog")
        details = {"type": dialog.type, "message": str(dialog.message)[:2_000]}
        if response == "accept":
            await dialog.accept(text)
        elif response == "dismiss":
            await dialog.dismiss()
        else:
            raise ValueError("dialog response must be accept or dismiss")
        self._dialogs.pop(tab_id, None)
        self._dialog_events.setdefault(tab_id, asyncio.Event()).clear()
        task = self._dialog_tasks.pop(tab_id, None)
        if task is not None:
            await asyncio.wait_for(task, timeout=10.0)
        return details

    async def history(self, tab_id: str, direction: str) -> None:
        _, page = await self._page(tab_id)
        if direction == "back":
            await page.go_back(wait_until="domcontentloaded")
        elif direction == "forward":
            await page.go_forward(wait_until="domcontentloaded")
        elif direction == "reload":
            await page.reload(wait_until="domcontentloaded")

    async def close_tab(self, tab_id: str) -> None:
        _, page = await self._page(tab_id)
        await page.close()

    async def close(self) -> None:
        # Never leave an Agent turn blocked if the Browser is shut down while
        # the user owns control.
        await self.resume_agent()
        if self._context is not None:
            await self._context.close()
            self._context = None
        if self._playwright is not None:
            await self._playwright.stop()
            self._playwright = None
        self._tabs.clear()
        self._page_ids.clear()
        self._console_logs.clear()
        self._network_log.clear()
        self._dialogs.clear()
        self._dialog_events.clear()
        for task in self._dialog_tasks.values():
            task.cancel()
        self._dialog_tasks.clear()


def _css_escape(value: str) -> str:
    if not value or any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for character in value):
        raise ValueError("Invalid browser element ref")
    return value


def _normalize_key(value: str) -> str:
    """Accept common model spellings while preserving Playwright chords."""
    names = {
        "CTRL": "Control", "CONTROL": "Control", "CMD": "Meta", "COMMAND": "Meta",
        "META": "Meta", "ALT": "Alt", "OPTION": "Alt", "SHIFT": "Shift",
        "ENTER": "Enter", "RETURN": "Enter", "TAB": "Tab", "ESC": "Escape",
        "ESCAPE": "Escape", "SPACE": "Space", "BACKSPACE": "Backspace",
        "DELETE": "Delete", "INSERT": "Insert", "HOME": "Home", "END": "End",
        "PAGEUP": "PageUp", "PAGEDOWN": "PageDown", "ARROWUP": "ArrowUp",
        "ARROWDOWN": "ArrowDown", "ARROWLEFT": "ArrowLeft", "ARROWRIGHT": "ArrowRight",
        "UP": "ArrowUp", "DOWN": "ArrowDown", "LEFT": "ArrowLeft", "RIGHT": "ArrowRight",
    }
    parts = value.split("+")
    normalized = [names.get(part.strip().upper(), part.strip()) for part in parts]
    return "+".join(normalized)


_SNAPSHOT_SCRIPT = r"""
(prefix) => {
  const selector = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'textarea', 'select',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="tab"]', '[role="menuitem"]', '[contenteditable="true"]', '[tabindex]'
  ].join(',');
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  let next = 1;
  const elements = [];
  const roots = [document];
  const candidates = [];
  while (roots.length) {
    const root = roots.shift();
    candidates.push(...root.querySelectorAll(selector));
    for (const host of root.querySelectorAll('*')) {
      if (host.shadowRoot) roots.push(host.shadowRoot);
    }
  }
  for (const element of candidates) {
    if (!visible(element) || elements.length >= 300) continue;
    let ref = element.getAttribute('data-openyak-ref');
    if (!ref || !ref.startsWith(prefix)) {
      ref = `${prefix}e${next++}`;
      while (document.querySelector(`[data-openyak-ref="${ref}"]`)) ref = `${prefix}e${next++}`;
      element.setAttribute('data-openyak-ref', ref);
    }
    const rect = element.getBoundingClientRect();
    const labelledBy = element.getAttribute('aria-labelledby');
    const label = element.getAttribute('aria-label')
      || (labelledBy && document.getElementById(labelledBy)?.innerText)
      || element.labels?.[0]?.innerText
      || element.innerText
      || element.getAttribute('placeholder')
      || element.getAttribute('title')
      || '';
    const value = element.type === 'password' ? '' : (element.value || '');
    elements.push({
      ref,
      role: element.getAttribute('role') || element.tagName.toLowerCase(),
      name: String(label).trim().slice(0, 300),
      value: String(value).slice(0, 500),
      disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
      checked: typeof element.checked === 'boolean' ? element.checked : undefined,
      selected: Boolean(element.selected || element.getAttribute('aria-selected') === 'true'),
      expanded: element.getAttribute('aria-expanded') === null ? undefined : element.getAttribute('aria-expanded') === 'true',
      href: element.href ? String(element.href).slice(0, 1000) : undefined,
      input_type: element instanceof HTMLInputElement ? element.type : undefined,
      bounds: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)]
    });
  }
  return {
    elements,
    text: String(document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 12000)
  };
}
"""


_DOM_STABILITY_SCRIPT = r"""
() => {
  const root = document.body;
  if (!root) return 'no-body';
  const busy = document.querySelectorAll(
    '[aria-busy="true"], progress, [role="progressbar"]'
  ).length;
  return [
    busy,
    location.href,
    document.readyState,
    root.childElementCount,
    root.innerText.length,
    document.querySelectorAll('*').length,
    busy,
  ].join(':');
}
"""
