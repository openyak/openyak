# OpenYak UI Preflight

This preflight is the shared UI safety net for OpenYak. It runs the real Next.js app in a visible Chromium browser by default and mocks backend/proxy responses at the network layer, so the checks do not depend on local API keys, a running FastAPI server, or a remote tunnel.

Run it from the repository root:

```bash
npm run preflight:ui
```

Local runs default to headed GUI mode. CI runs default to headless; you can force headless locally with:

```bash
OPENYAK_UI_HEADLESS=true npm run preflight:ui
```

If Playwright browsers are not installed on a fresh machine:

```bash
cd frontend && npx playwright install chromium
```

## Feature Inventory

- Desktop shell: root redirect, sidebar/history, settings sidebar, mobile nav, panel gutters, route progress, onboarding gate.
- Chat: new chat landing, provider/model selector, agent mode switch, workspace selector, file attachment entry, prompt submission, session route, persisted conversation render, long conversation pagination, multi-conversation switching, export, workspace side panel, streaming state, manual and automatic context compression.
- Message and session controls: historical message edit/resend, stop generation, assistant activity/feedback, sidebar pin/rename/export/delete/undo.
- Settings: general appearance/language/about, providers across BYOK/ChatGPT/Rapid-MLX/Ollama/custom, automations, plugins/connectors/skills, remote access, usage, workspace memory.
- Automations: active/all/template tabs, create/edit dialog, schedule/loop modes, run/delete/result links.
- Plugins: connector status and auth actions, custom connector creation, plugin enable/detail, skill enable/install/search.
- Remote: desktop tunnel enable/copy/QR/token/permission controls, mobile task list, mobile new task, remote provider/model sync.
- Usage: overview, model/session/daily breakdown, and cost/token trends.
- Edge states: backend auth expiry, mobile needs-input, remote tunnel health failure, connector auth failure.
- Workspace memory: list, expand, edit, export, delete confirmation.

## Current Preflight List

- Desktop chat workflow: `/c/new` landing is usable, model is loaded, mode can switch, file upload and `@mention` attach through the UI, prompt submission reaches the backend mock, the created session shows persisted attachments, workspace panel opens.
- Desktop history path: direct session route renders prior user/assistant messages, export is available, sidebar navigation switches sessions.
- Desktop search workflow: command palette opens with keyboard shortcut, searches mocked history, and navigates to a session.
- Artifact workflow: persisted artifact cards open the right panel for Markdown, HTML, CSV, SVG/Mermaid coverage cards, and submit-plan cards open the plan review panel.
- Interactive workflow: permission request, agent question, and plan review prompts are emitted through mocked SSE and answered only by GUI controls.
- Settings walkthrough: every settings tab is reachable through the real settings navigation and exposes its primary controls/data.
- Provider settings workflow: BYOK/ChatGPT/local/custom provider modes render and accept their GUI configuration controls.
- Workspace memory workflow: memory list expands, edit saves, export runs, delete confirmation opens and closes through the dialog.
- Automations flow: create dialog accepts the core fields, closes after create, templates tab loads and can instantiate a template.
- Automations management workflow: run-now, history expansion, edit dialog, and delete confirmation are exercised.
- Plugins flow: connectors search, custom connector form, plugins tab, skills tab, skill-store search.
- Remote desktop flow: disabled state, enable tunnel, tunnel URL/copy/rotate controls.
- Mobile settings workflow: token handoff shows connected state and provider selection.
- Mobile remote flow: `/m` task list from token handoff, `/m/new` model selector, submit task to the backend mock.

## Complete Workflow Suite

`openyak-workflows.spec.ts` is the stricter user-journey layer on top of the broader smoke preflight. These tests preserve browser state across navigation and assert both visible GUI outcomes and the backend payloads the UI submits.

- Chat task journey: open a workspace-scoped new chat, upload a file, attach a workspace file by `@mention`, send, land on the created session, reload persisted messages, search, and reopen the session.
- Provider setup journey: configure BYOK through the provider GUI, verify the chat composer switches to the BYOK model, submit with that provider/model, then configure a Custom Endpoint for local or remote OpenAI-compatible APIs.
- Automation lifecycle journey: create an automation, run it manually, open run history, edit it, delete it, and verify the list reflects each lifecycle transition.
- Remote mobile handoff journey: enable desktop remote access, rotate the token, open the mobile connection flow, switch mobile provider, and submit a mobile task with the selected provider/model.

## Office And Error-State Suite

`openyak-office-errors.spec.ts` covers heavier artifact/file paths and negative flows that should stay recoverable in the GUI.

- Office artifact workflow: opens DOCX, XLSX, PDF, and PPTX file-preview artifacts from real binary fixture bytes through `/api/files/content-binary`.
- Artifact error workflow: missing binary preview shows the backend `File not found` detail in the artifact panel instead of a runtime overlay.
- Upload error workflow: failed file upload surfaces a toast and leaves the chat composer usable.
- Provider error workflow: 429 and 402 responses surface recoverable composer errors without opening an upgrade dialog.
- Mobile remote error workflow: invalid remote token fails on `/m/settings` and does not enter the task flow.

## Conversation Scale And Compression Suite

`openyak-conversation-scale.spec.ts` covers long-running conversation behavior that must match real user motion through the GUI.

- Manual compression workflow: opens a high-context session, clicks the context indicator, starts `/api/chat/compact`, and verifies the persisted compaction marker.
- Auto compression workflow: sends a prompt whose stream emits compaction events, then verifies the final conversation includes the compressed-context marker.
- Long conversation workflow: loads the latest page of a 120-message conversation first, then uses reverse scroll to fetch older history.
- Multi-conversation workflow: switches between several sidebar conversations and verifies content does not bleed across sessions.

## Natural Office Workflow Suite

`openyak-natural-office-workflows.spec.ts` covers the day-to-day employee prompts that OpenYak claims to handle. These are GUI workflows with normal workplace language, uploaded Office/PDF files, persisted assistant output, artifact cards, and same-thread follow-up. The suite rejects test-marker prompts such as `WF_*` or "assistant answer must..." so the flow stays close to real user motion.

- Memo workflow: upload customer feedback notes and request a VP-ready memo with themes, revenue risk, owners, and email copy.
- Budget workflow: upload a workbook and request budget/actual/forecast comparison, variance, and owner questions.
- Deck workflow: upload a QBR deck and request slide feedback, evidence gaps, speaker-note fixes, and a decision ask.
- Vendor workflow: upload renewal notes and request obligations, deadlines, risks, named owners, and next actions.
- Board packet workflow: upload memo, workbook, deck, and vendor terms, then create a board-ready brief, risk-owner table, and artifact cards.
- Same-thread follow-up workflow: continue from the board packet and ask for a RACI plus 30-day agenda.

## Edge-State Regression Suite

`openyak-edge-regressions.spec.ts` covers recoverability and remote edge states.

- Auth expiry workflow: a backend 401 during prompt submission shows a recoverable error and leaves the composer usable.
- Mobile needs-input workflow: the task list badge opens the detail page, receives the prompt over SSE, and responds from the GUI.
- Mobile remote disconnect workflow: an unreachable desktop tunnel shows disconnected health while keeping tasks visible.
- Connector auth failure workflow: OAuth/connect failure is surfaced as a toast instead of an unhandled UI error.

## Deep Surface Suite

`openyak-deep-surfaces.spec.ts` covers the claimed desktop feature surfaces that are easy to miss in happy-path smoke tests. It is desktop-only because these controls live in the desktop shell; mobile has dedicated remote workflows above.

- Message control workflow: edits and resends a historical user message, verifies `/api/chat/edit`, starts a slow stream, then stops it from the GUI and verifies `/api/chat/abort`.
- Assistant action workflow: opens the activity panel from an assistant/tool response and toggles good/bad feedback controls.
- Model selector workflow: opens the model dropdown, uses sort/search, selects a custom BYOK model, and verifies the prompt payload uses that provider/model.
- Sidebar workflow: opens the real session menu, unpins, renames, exports Markdown/PDF, confirms delete, and uses undo.
- Workspace workflow: expands progress and files, edits scratchpad text, opens `plan.md`, and verifies the file-preview artifact panel.
- Remote workflow: enables remote access, verifies QR visibility, changes permission mode, rotates token, configures a Telegram channel, and disables remote access.
- Standalone/onboarding workflow: verifies `/automations`, `/plugins`, and `/remote` outside settings, then runs first-run onboarding auth error and skip-to-provider recovery.

## Remaining Regression Candidates

- Real backend + real database integration, outside the network-mocked UI preflight.
- Opt-in live GPT-5.5 subscription audits with MP4 recording for latency and provider behavior validation.
- Visual regression snapshots for dense desktop/mobile layouts.
- Performance budgets for very large histories and heavyweight Office previews.
