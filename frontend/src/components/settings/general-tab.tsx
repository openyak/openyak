"use client";

import { useState, useEffect, useCallback } from "react";
import { Sun, Moon, Monitor, RefreshCw, Check, Eye, EyeOff } from "lucide-react";
import { useTheme } from "next-themes";
import { useTranslation } from "react-i18next";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { IS_DESKTOP } from "@/lib/constants";
import { TextPart } from "@/components/parts/text-part";
import { AppearanceCustomize } from "@/components/settings/appearance-customize";

export function GeneralTab() {
  const { t, i18n } = useTranslation('settings');
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [appVersion, setAppVersion] = useState("0.0.1");
  const [updateStatus, setUpdateStatus] = useState<"idle" | "checking" | "available" | "up-to-date" | "downloading" | "error">("idle");
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!IS_DESKTOP) return;
    import("@tauri-apps/api/app").then(({ getVersion }) =>
      getVersion().then(setAppVersion)
    ).catch(() => {});
  }, []);

  const checkForUpdate = useCallback(async () => {
    if (!IS_DESKTOP) return;
    setUpdateStatus("checking");
    setUpdateError(null);
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        setUpdateVersion(update.version);
        setUpdateStatus("available");
      } else {
        setUpdateVersion(null);
        setUpdateStatus("up-to-date");
        setTimeout(() => setUpdateStatus("idle"), 3000);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn("Update check failed:", message);
      setUpdateVersion(null);
      setUpdateError(message);
      setUpdateStatus("error");
    }
  }, []);

  const doUpdate = useCallback(async () => {
    if (!IS_DESKTOP) return;
    setUpdateStatus("downloading");
    setUpdateError(null);
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) return;
      let totalLength = 0;
      let downloaded = 0;
      await update.downloadAndInstall((event: any) => {
        if (event.event === "Started" && event.data.contentLength) {
          totalLength = event.data.contentLength;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength ?? 0;
          if (totalLength > 0) setDownloadProgress(Math.round((downloaded / totalLength) * 100));
        }
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("Update install failed:", message);
      setUpdateError(message);
      setUpdateStatus("error");
    }
  }, []);

  const [showPreview, setShowPreview] = useState(false);
  const [proseFont, setProseFont] = useState<"serif" | "sans">("serif");
  const activeAppearance = mounted
    ? resolvedTheme === "light"
      ? t("light")
      : t("dark")
    : null;

  return (
    <div className="space-y-8">
      {/* Theme Section */}
      <section>
        <h2 className="text-ui-title-sm font-semibold text-[var(--text-primary)] mb-3">
          {t('appearance')}
        </h2>
        <div className="grid grid-cols-3 gap-2">
          {[
            { value: "light", label: t('light'), icon: Sun },
            { value: "dark", label: t('dark'), icon: Moon },
            { value: "system", label: t('system'), icon: Monitor },
          ].map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              onClick={() => setTheme(value)}
              className={`flex flex-col items-center gap-2 rounded-xl border p-4 transition-colors ${
                mounted && theme === value
                  ? "border-[var(--brand-primary)] bg-[var(--brand-primary)]/5"
                  : "border-[var(--border-default)] hover:bg-[var(--surface-secondary)]"
              }`}
            >
              <Icon className="h-5 w-5" />
              <span className="text-ui-caption font-medium">{label}</span>
            </button>
          ))}
        </div>
        {activeAppearance && (
          <p className="mt-3 text-ui-caption text-[var(--text-tertiary)]">
            {theme === "system"
              ? t("appearanceActiveSystem", { appearance: activeAppearance })
              : t("appearanceActive", { appearance: activeAppearance })}
          </p>
        )}

        {/* Typography Preview */}
        <button
          onClick={() => setShowPreview(!showPreview)}
          className="mt-3 flex items-center gap-1.5 text-ui-caption text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
        >
          {showPreview ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          Typography Preview
        </button>
        <div className="mt-6">
          <AppearanceCustomize />
        </div>

        {showPreview && (
          <>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {([
                { value: "serif", label: "Serif" },
                { value: "sans", label: "Sans-serif" },
              ] as const).map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => setProseFont(value)}
                  className={`rounded-lg border px-3 py-2 text-ui-caption font-medium transition-colors ${
                    proseFont === value
                      ? "border-[var(--brand-primary)] bg-[var(--brand-primary)]/5"
                      : "border-[var(--border-default)] hover:bg-[var(--surface-secondary)]"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div
              className="mt-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-chat)] p-5 overflow-y-auto max-h-[70vh]"
              style={{ ["--prose-font" as string]: PROSE_FONT_STACKS[proseFont] }}
            >
              <TextPart data={{ type: "text", text: TYPOGRAPHY_SAMPLE }} />
            </div>
          </>
        )}
      </section>

      <Separator />

      {/* Language Section */}
      <section>
        <h2 className="text-ui-title-sm font-semibold text-[var(--text-primary)] mb-3">
          {t('language')}
        </h2>
        <div className="grid grid-cols-2 gap-2">
          {[
            { value: "en", label: "English" },
            { value: "zh", label: "中文" },
          ].map(({ value, label }) => (
            <button
              key={value}
              onClick={() => {
                i18n.changeLanguage(value);
                localStorage.setItem("openyak-language", value);
              }}
              className={`flex flex-col items-center gap-2 rounded-xl border p-4 transition-colors ${
                mounted && i18n.language.startsWith(value)
                  ? "border-[var(--brand-primary)] bg-[var(--brand-primary)]/5"
                  : "border-[var(--border-default)] hover:bg-[var(--surface-secondary)]"
              }`}
            >
              <span className="text-ui-caption font-medium">{label}</span>
            </button>
          ))}
        </div>
      </section>

      <Separator />

      {/* About */}
      <section>
        <h2 className="text-ui-title-sm font-semibold text-[var(--text-primary)] mb-3">
          {t('about')}
        </h2>
        <div className="text-ui-caption text-[var(--text-secondary)] space-y-1">
          <p>{t('aboutVersion', { version: appVersion })}</p>
          <p>{t('aboutDesc')}</p>
          <p>{t('aboutCopyright')}</p>
        </div>
        {IS_DESKTOP && (
          <div className="mt-3">
            {updateStatus === "idle" && (
              <Button variant="outline" size="sm" className="text-ui-caption h-7" onClick={checkForUpdate}>
                {t('checkForUpdates')}
              </Button>
            )}
            {updateStatus === "checking" && (
              <Button variant="outline" size="sm" className="text-ui-caption h-7" disabled>
                <RefreshCw className="h-3 w-3 mr-1.5 animate-spin" />
                {t('checkForUpdates')}
              </Button>
            )}
            {updateStatus === "up-to-date" && (
              <Button variant="outline" size="sm" className="text-ui-caption h-7 text-green-500 border-green-500/30" disabled>
                <Check className="h-3 w-3 mr-1.5" />
                {t('upToDate')}
              </Button>
            )}
            {updateStatus === "available" && (
              <Button size="sm" className="text-ui-caption h-7" onClick={doUpdate}>
                {t('updateNow')} — v{updateVersion}
              </Button>
            )}
            {updateStatus === "downloading" && (
              <div className="flex items-center gap-2">
                <div className="h-1.5 w-32 rounded-full bg-[var(--surface-secondary)] overflow-hidden">
                  <div
                    className="h-full rounded-full bg-[var(--brand-primary)] transition-all duration-300"
                    style={{ width: `${downloadProgress}%` }}
                  />
                </div>
                <span className="text-ui-caption text-[var(--text-secondary)]">{downloadProgress}%</span>
              </div>
            )}
            {updateStatus === "error" && (
              <div className="space-y-1.5">
                <Button variant="outline" size="sm" className="text-ui-caption h-7 text-[var(--color-destructive)]" onClick={checkForUpdate}>
                  {t('checkForUpdates')}
                </Button>
                {updateError && (
                  <p className="text-ui-3xs text-[var(--color-destructive)] break-all">{updateError}</p>
                )}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

const PROSE_FONT_STACKS = {
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  sans: '"Inter", "Noto Sans SC", ui-sans-serif, system-ui, sans-serif',
} as const;

const TYPOGRAPHY_SAMPLE = `# Heading Level 1

This is an introductory paragraph that provides context. It should have comfortable spacing below and the heading above should feel like a clear section break.

## 第二级标题 — Section Heading

This paragraph follows an H2 heading and should sit close to it, forming a cohesive section. The heading pulls toward its content below, not floating in the middle.

Here's a second paragraph. Notice the rhythm between consecutive paragraphs — they should feel connected but not cramped.

### 三级标题 Features

Lists should feel structured and scannable:

- **First item** — with a bold lead and description after
- Second item with a [link example](https://example.com) inline
- Third item with \`inline code\` reference
  - Nested item one
  - Nested item two
    - Deeply nested item

#### H4 SUB-HEADING

Ordered lists with clear numbering:

1. Install the dependencies
2. Configure the environment variables
3. Run the development server

---

## 代码块展示

Here's a code example:

\`\`\`python
def hello(name: str) -> str:
    """Greet someone by name."""
    return f"Hello, {name}!"

# Usage
result = hello("OpenYak")
print(result)
\`\`\`

The code block above should feel like a distinct zone with premium quality.

## 表格与引用

| Feature | REST | GraphQL |
|---------|------|---------|
| Endpoint | Multiple | Single |
| Data Fetching | Over/Under-fetch | Exact fields |
| Caching | HTTP native | Custom |
| Learning Curve | Low | Medium |

> 引用块应该有清晰的视觉边界，但不要过重。这是一段引用内容，用来测试 blockquote 的排版效果。

## 弱结构文本测试

项目名称：OpenYak
类型：AI 桌面助手
技术栈：Tauri + Next.js + FastAPI
开源协议：MIT
核心卖点：本地优先

这一段是正常长度的段落，用来测试弱结构短段落和正常段落之间的视觉过渡。上面的短段落应该收紧间距，形成一个视觉组，而不是散乱的换行。
`;
