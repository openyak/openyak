"""Built-in automation templates with bilingual support (zh/en)."""

from __future__ import annotations

_TEMPLATES: list[dict] = [
    {
        "id": "daily-briefing",
        "name": {"zh": "每日简报", "en": "Daily Briefing"},
        "description": {
            "zh": "每天早上生成当日简报，包含待办事项和优先级",
            "en": "Generate a daily briefing each morning with todos and priorities",
        },
        "prompt": {
            "zh": (
                "请为我生成今日简报，包含以下内容：\n"
                "1. 当前工作区的重要文件变更摘要\n"
                "2. 待处理的关键任务和优先级\n"
                "3. 需要关注的事项提醒\n"
                "请用简洁清晰的格式输出。"
            ),
            "en": (
                "Generate today's briefing with:\n"
                "1. Summary of important file changes in the workspace\n"
                "2. Key pending tasks and priorities\n"
                "3. Items that need attention\n"
                "Use a concise, clear format."
            ),
        },
        "schedule_config": {"type": "cron", "cron": "0 8 * * *"},
        "category": "productivity",
        "icon": "Sunrise",
    },
    {
        "id": "weekly-recap",
        "name": {"zh": "每周回顾", "en": "Weekly Recap"},
        "description": {
            "zh": "每周五下午总结本周工作，规划下周计划",
            "en": "Summarize the week's work every Friday and plan for next week",
        },
        "prompt": {
            "zh": (
                "请为我生成本周工作回顾：\n"
                "1. 本周主要完成的工作和成果\n"
                "2. 遇到的阻碍和待解决问题\n"
                "3. 下周工作计划和优先级建议\n"
                "请保持简洁、可操作。"
            ),
            "en": (
                "Generate a weekly work recap:\n"
                "1. Key accomplishments this week\n"
                "2. Blockers and unresolved issues\n"
                "3. Next week's plan and priority suggestions\n"
                "Keep it concise and actionable."
            ),
        },
        "schedule_config": {"type": "cron", "cron": "0 17 * * 5"},
        "category": "productivity",
        "icon": "CalendarCheck",
    },
    {
        "id": "inbox-digest",
        "name": {"zh": "邮件整理", "en": "Email Digest"},
        "description": {
            "zh": "工作日早上整理和摘要近期邮件",
            "en": "Organize and summarize recent emails on weekday mornings",
        },
        "prompt": {
            "zh": (
                "请帮我整理近期邮件：\n"
                "1. 摘要重要的未读邮件\n"
                "2. 按优先级排序需要回复的内容\n"
                "3. 为需要回复的邮件草拟简短回复\n"
                "4. 标记紧急事项"
            ),
            "en": (
                "Help me organize recent emails:\n"
                "1. Summarize important unread emails\n"
                "2. Prioritize items that need replies\n"
                "3. Draft brief replies for emails that need responses\n"
                "4. Flag urgent items"
            ),
        },
        "schedule_config": {"type": "cron", "cron": "0 9 * * 1-5"},
        "category": "communication",
        "icon": "Mail",
    },
    {
        "id": "code-review-digest",
        "name": {"zh": "代码审查摘要", "en": "Code Review Digest"},
        "description": {
            "zh": "工作日汇总待审 PR 和代码变更",
            "en": "Summarize pending PRs and code changes on weekdays",
        },
        "prompt": {
            "zh": (
                "请检查当前工作区的代码变更情况：\n"
                "1. 最近的代码提交摘要\n"
                "2. 待审查的 Pull Request\n"
                "3. 需要关注的代码质量问题\n"
                "请给出简明的审查建议。"
            ),
            "en": (
                "Review code changes in the workspace:\n"
                "1. Summary of recent commits\n"
                "2. Pending Pull Requests to review\n"
                "3. Code quality issues to watch\n"
                "Provide concise review suggestions."
            ),
        },
        "schedule_config": {"type": "cron", "cron": "0 10 * * 1-5"},
        "category": "development",
        "icon": "GitPullRequest",
    },
    {
        "id": "workspace-cleanup",
        "name": {"zh": "工作区清理", "en": "Workspace Cleanup"},
        "description": {
            "zh": "每周六分析工作区，建议清理项目（只报告不删除）",
            "en": "Analyze workspace weekly and suggest cleanup (report only, no deletions)",
        },
        "prompt": {
            "zh": (
                "请分析当前工作区并建议清理操作：\n"
                "1. 查找大文件或目录\n"
                "2. 识别可能不再使用的文件\n"
                "3. 建议目录整理方案\n"
                "注意：只报告发现，不要删除任何文件。"
            ),
            "en": (
                "Analyze the workspace and suggest cleanup:\n"
                "1. Find large files or directories\n"
                "2. Identify potentially unused files\n"
                "3. Suggest directory organization\n"
                "Note: Only report findings, do not delete any files."
            ),
        },
        "schedule_config": {"type": "cron", "cron": "0 12 * * 6"},
        "category": "maintenance",
        "icon": "FolderSync",
    },
    # --- Loop templates (office / productivity scenarios) ---
    {
        "id": "loop-email-batch",
        "name": {"zh": "批量处理邮件 (循环)", "en": "Batch Process Emails (Loop)"},
        "description": {
            "zh": "逐封处理收件箱中的待办邮件，草拟回复或归档",
            "en": "Process inbox emails one by one — draft replies or archive",
        },
        "prompt": {
            "zh": (
                "查看收件箱中下一封未处理的邮件。根据内容决定：\n"
                "- 需要回复的：草拟一封简洁的回复\n"
                "- 仅供知会的：标记为已读并归档\n"
                "- 需要跟进的：创建一个待办提醒\n"
                "如果所有邮件都已处理完毕，输出 [LOOP_DONE]。"
            ),
            "en": (
                "Check the next unprocessed email in the inbox. Based on content:\n"
                "- Needs reply: draft a concise response\n"
                "- FYI only: mark as read and archive\n"
                "- Needs follow-up: create a todo reminder\n"
                "If all emails are processed, output [LOOP_DONE]."
            ),
        },
        "schedule_config": None,
        "category": "loop",
        "icon": "Repeat",
        "loop_max_iterations": 20,
        "loop_preset": "email-batch",
    },
    {
        "id": "loop-doc-review",
        "name": {"zh": "文档逐章审阅 (循环)", "en": "Document Review by Section (Loop)"},
        "description": {
            "zh": "逐章审阅长文档，检查逻辑、语法和格式",
            "en": "Review a long document section by section for logic, grammar, and formatting",
        },
        "prompt": {
            "zh": (
                "阅读文档的下一个章节，检查以下问题并修正：\n"
                "1. 逻辑是否连贯，论述是否充分\n"
                "2. 语法和用词是否准确\n"
                "3. 格式是否统一\n"
                "给出修改建议或直接修正。"
                "如果所有章节都已审阅完毕，输出 [LOOP_DONE]。"
            ),
            "en": (
                "Read the next section of the document and check:\n"
                "1. Is the logic coherent and reasoning sound?\n"
                "2. Are grammar and wording accurate?\n"
                "3. Is formatting consistent?\n"
                "Suggest edits or fix directly. "
                "If all sections are reviewed, output [LOOP_DONE]."
            ),
        },
        "schedule_config": None,
        "category": "loop",
        "icon": "Repeat",
        "loop_max_iterations": 15,
        "loop_preset": "doc-review",
    },
    {
        "id": "loop-data-cleanup",
        "name": {"zh": "数据批量清洗 (循环)", "en": "Batch Data Cleanup (Loop)"},
        "description": {
            "zh": "逐批清洗和标准化表格数据",
            "en": "Clean and standardize spreadsheet data batch by batch",
        },
        "prompt": {
            "zh": (
                "检查数据中的下一批记录，执行以下清洗操作：\n"
                "- 修正格式不一致的字段（日期、电话、地址等）\n"
                "- 标记或删除重复记录\n"
                "- 补全缺失的必填字段\n"
                "如果所有数据都已清洗完毕，输出 [LOOP_DONE]。"
            ),
            "en": (
                "Check the next batch of records and perform cleanup:\n"
                "- Fix inconsistent formatting (dates, phones, addresses)\n"
                "- Flag or remove duplicate entries\n"
                "- Fill in missing required fields\n"
                "If all data is cleaned, output [LOOP_DONE]."
            ),
        },
        "schedule_config": None,
        "category": "loop",
        "icon": "Repeat",
        "loop_max_iterations": 10,
        "loop_preset": "data-cleanup",
    },
]


def _resolve_lang(value: str | dict, lang: str) -> str:
    """Extract the localized string from a value that may be a dict or plain str."""
    if isinstance(value, dict):
        return value.get(lang) or value.get("en") or next(iter(value.values()))
    return value


def _resolve_template(t: dict, lang: str) -> dict:
    """Resolve a template to the requested language, including loop fields."""
    result = {
        "id": t["id"],
        "name": _resolve_lang(t["name"], lang),
        "description": _resolve_lang(t["description"], lang),
        "prompt": _resolve_lang(t["prompt"], lang),
        "schedule_config": t["schedule_config"],
        "category": t["category"],
        "icon": t["icon"],
    }
    # Include loop fields if present
    if "loop_max_iterations" in t:
        result["loop_max_iterations"] = t["loop_max_iterations"]
    if "loop_preset" in t:
        result["loop_preset"] = t["loop_preset"]
    return result


def get_templates(lang: str = "zh") -> list[dict]:
    """Return all built-in automation templates in the requested language."""
    return [_resolve_template(t, lang) for t in _TEMPLATES]


def get_template_by_id(template_id: str, lang: str = "zh") -> dict | None:
    """Look up a template by its id, resolved to the requested language."""
    for t in _TEMPLATES:
        if t["id"] == template_id:
            return _resolve_template(t, lang)
    return None
