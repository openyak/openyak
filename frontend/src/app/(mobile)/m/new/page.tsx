"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowUp, Loader2, Paperclip, Camera, X, ChevronDown, FolderOpen } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { API } from "@/lib/constants";
import { isRemoteMode, getRemoteConfig } from "@/lib/remote-connection";
import { useProviderModels } from "@/hooks/use-provider-models";
import { useSettingsStore } from "@/stores/settings-store";
import { MobileDirectoryBrowser } from "@/components/mobile/directory-browser";

const VISION_MODEL_REQUIRED_MESSAGE = "The selected model does not support images. Choose a vision model and try again.";

/**
 * Mobile new task page.
 *
 * Model list comes from useProviderModels() (reads Zustand activeProvider).
 * Selected model comes from useSettingsStore.selectedModel.
 * Both are synced by the mobile layout's useRemoteProviderSync().
 * No local provider/model state — single source of truth.
 */
export default function MobileNewTaskPage() {
  const router = useRouter();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [browsingDirs, setBrowsingDirs] = useState(false);

  // Workspace directory — read from settings store (persisted in localStorage)
  const workspaceDirectory = useSettingsStore((s) => s.workspaceDirectory);
  const setWorkspaceDirectory = useSettingsStore((s) => s.setWorkspaceDirectory);

  // Read model state from Zustand (synced by layout)
  const { data: models, isLoading: loadingModels } = useProviderModels();
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const setSelectedModel = useSettingsStore((s) => s.setSelectedModel);

  useEffect(() => {
    if (!isRemoteMode()) {
      router.replace("/m/settings");
      return;
    }
    // If models loaded but nothing selected, pick first
    if (models.length > 0 && !selectedModel) {
      setSelectedModel(models[0].id, models[0].provider_id);
    }
  }, [router, models, selectedModel, setSelectedModel]);

  const handleTextChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setFiles((prev) => [...prev, ...Array.from(e.target.files!)]);
    }
  }, []);

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!text.trim() || sending) return;
    const selectedModelInfo = models.find((model) => model.id === selectedModel);
    if (files.some((file) => file.type.startsWith("image/")) && selectedModelInfo?.capabilities.vision !== true) {
      toast.error(VISION_MODEL_REQUIRED_MESSAGE);
      return;
    }
    setSending(true);

    try {
      const attachments: { type: string; path: string; name: string }[] = [];
      const remoteConfig = getRemoteConfig();

      for (const file of files) {
        const formData = new FormData();
        formData.append("file", file);
        const uploadUrl = remoteConfig
          ? `${remoteConfig.url}${API.FILES.UPLOAD}`
          : API.FILES.UPLOAD;
        const result = await fetch(uploadUrl, {
          method: "POST",
          headers: remoteConfig
            ? { Authorization: `Bearer ${remoteConfig.token}` }
            : {},
          body: formData,
        });
        if (result.ok) {
          const data = await result.json();
          attachments.push({
            type: data.mime_type?.startsWith("image/") ? "image" : "file",
            path: data.path,
            name: data.name,
          });
        }
      }

      const response = await api.post<{ stream_id: string; session_id: string }>(
        API.CHAT.PROMPT,
        {
          text: text.trim(),
          model: selectedModel || null,
          provider_id: useSettingsStore.getState().selectedProviderId || null,
          attachments,
          workspace: workspaceDirectory || null,
        },
      );

      router.push(`/m/task/_?sessionId=${encodeURIComponent(response.session_id)}&stream_id=${response.stream_id}`);
    } catch (err) {
      console.error("Failed to send task:", err);
      toast.error("Failed to send task. Check your connection.");
      setSending(false);
    }
  }, [text, sending, files, models, selectedModel, workspaceDirectory, router]);

  // Current model name for display
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 pt-[max(env(safe-area-inset-top),12px)] pb-3">
        <button
          onClick={() => router.back()}
          className="h-9 w-9 flex items-center justify-center rounded-full hover:bg-[var(--surface-secondary)] active:scale-[0.95] transition-all"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-lg font-semibold tracking-tight">New Task</h1>
      </header>

      {/* Main content — push input to bottom like a chat app */}
      <div className="flex-1 flex flex-col justify-end px-4 pb-[max(env(safe-area-inset-bottom),12px)]">

        {/* Model selector — single dropdown, filtered by provider from Settings */}
        <div className="relative mb-4">
          <select
            value={selectedModel ?? ""}
            onChange={(e) => {
              const model = models.find((m) => m.id === e.target.value);
              setSelectedModel(e.target.value, model?.provider_id ?? null);
            }}
            disabled={loadingModels || models.length === 0}
            className="w-full appearance-none pl-3 pr-7 py-2 rounded-full bg-[var(--surface-secondary)] text-[16px] font-medium border border-[var(--border-default)] text-[var(--text-primary)] disabled:opacity-50 focus:outline-none focus:border-[var(--border-heavy)]"
          >
            {loadingModels ? (
              <option>Loading...</option>
            ) : models.length === 0 ? (
              <option>No models — check Settings</option>
            ) : (
              models.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))
            )}
          </select>
          <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-tertiary)] pointer-events-none" />
        </div>

        {/* Workspace selector */}
        <button
          onClick={() => setBrowsingDirs(true)}
          className="w-full flex items-center gap-2.5 px-3 py-2 mb-4 rounded-full bg-[var(--surface-secondary)] border border-[var(--border-default)] active:scale-[0.98] transition-transform"
        >
          <FolderOpen className="w-4 h-4 text-[var(--text-tertiary)] shrink-0" />
          <span className={`flex-1 text-left text-[15px] truncate ${workspaceDirectory ? "text-[var(--text-primary)] font-medium" : "text-[var(--text-tertiary)]"}`}>
            {workspaceDirectory
              ? workspaceDirectory.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~")
              : "No workspace (full access)"}
          </span>
          {workspaceDirectory && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setWorkspaceDirectory(null);
              }}
              className="h-6 w-6 flex items-center justify-center rounded-full hover:bg-[var(--surface-tertiary)]"
            >
              <X className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
            </button>
          )}
        </button>

        <MobileDirectoryBrowser
          open={browsingDirs}
          onClose={() => setBrowsingDirs(false)}
          onSelect={setWorkspaceDirectory}
          initialPath={workspaceDirectory}
        />

        {/* Attached files */}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {files.map((file, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full bg-[var(--surface-secondary)] border border-[var(--border-default)] text-[12px]"
              >
                <span className="truncate max-w-[100px]">{file.name}</span>
                <button
                  onClick={() => removeFile(i)}
                  className="h-5 w-5 flex items-center justify-center rounded-full hover:bg-[var(--surface-tertiary)]"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Input area */}
        <div className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] shadow-[var(--shadow-sm)] focus-within:shadow-[var(--shadow-md)] focus-within:border-[var(--border-heavy)] transition-all">
          <div className="px-4 pt-3 pb-2">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={handleTextChange}
              placeholder="What should OpenYak do?"
              rows={1}
              className="w-full resize-none bg-transparent text-[16px] leading-relaxed outline-none placeholder:text-[var(--text-tertiary)] min-h-[28px] max-h-[200px]"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
            />
          </div>

          <div className="flex items-center justify-between gap-2 px-3 pb-2.5">
            <div className="flex items-center gap-1">
              <label className="h-8 w-8 flex items-center justify-center rounded-full hover:bg-[var(--surface-tertiary)] cursor-pointer transition-colors active:scale-[0.95]">
                <Camera className="w-[18px] h-[18px] text-[var(--text-tertiary)]" />
                <input type="file" accept="image/*" capture="environment" onChange={handleFileSelect} className="hidden" />
              </label>
              <label className="h-8 w-8 flex items-center justify-center rounded-full hover:bg-[var(--surface-tertiary)] cursor-pointer transition-colors active:scale-[0.95]">
                <Paperclip className="w-[18px] h-[18px] text-[var(--text-tertiary)]" />
                <input type="file" multiple onChange={handleFileSelect} className="hidden" />
              </label>
            </div>

            <button
              onClick={handleSubmit}
              disabled={!text.trim() || sending}
              className="h-8 w-8 flex items-center justify-center rounded-full bg-[var(--text-primary)] text-[var(--surface-primary)] disabled:opacity-30 active:scale-[0.9] transition-all"
            >
              {sending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <ArrowUp className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>

        <p className="mt-2.5 text-center text-[11px] text-[var(--text-tertiary)]">
          Tasks execute on your desktop computer
        </p>
      </div>
    </div>
  );
}
