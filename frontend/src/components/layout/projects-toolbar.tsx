"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Check,
  FolderClosed,
  FolderPlus,
  ListFilter,
  Maximize2,
  Minimize2,
  MessageSquare,
  Clock3,
  SquarePen,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { browseDirectory } from "@/lib/upload";
import { cn } from "@/lib/utils";
import { useSidebarStore, type OrganizeMode, type SortBy } from "@/stores/sidebar-store";

interface ProjectsToolbarProps {
  projectDirectories?: string[];
  variant?: "projects" | "chats";
}

export function ProjectsToolbar({ projectDirectories = [], variant = "projects" }: ProjectsToolbarProps) {
  const { t } = useTranslation("common");
  const router = useRouter();
  const collapseAllProjects = useSidebarStore((s) => s.collapseAllProjects);
  const expandAllProjects = useSidebarStore((s) => s.expandAllProjects);
  const collapsedProjects = useSidebarStore((s) => s.collapsedProjects);
  const [isPickingDirectory, setIsPickingDirectory] = useState(false);

  const allCollapsed =
    projectDirectories.length > 0 &&
    projectDirectories.every((d) => collapsedProjects[d]);
  const toggleLabel = t(allCollapsed ? "expandAll" : "collapseAll");

  const handleToggleAll = () => {
    if (projectDirectories.length === 0) return;
    if (allCollapsed) {
      expandAllProjects();
    } else {
      collapseAllProjects(projectDirectories);
    }
  };

  const handleAddProject = async () => {
    if (isPickingDirectory) return;
    setIsPickingDirectory(true);
    try {
      const path = await browseDirectory(t("addProject"));
      if (path) {
        router.push(`/c/new?directory=${encodeURIComponent(path)}`);
      }
    } catch (err) {
      console.error("Failed to pick project directory:", err);
      toast.error(t("addProjectFailed"));
    } finally {
      setIsPickingDirectory(false);
    }
  };

  const handleNewChat = () => {
    router.push("/c/new");
  };

  if (variant === "chats") {
    return (
      <div className="flex items-center gap-0.5">
        <FilterPopover />

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleNewChat}
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-[var(--sidebar-active)] hover:text-[var(--text-primary)]"
              aria-label={t("newChat")}
            >
              <SquarePen className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{t("newChat")}</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleToggleAll}
            disabled={projectDirectories.length === 0}
            className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-[var(--sidebar-active)] hover:text-[var(--text-primary)] disabled:opacity-40"
            aria-label={toggleLabel}
          >
            {allCollapsed ? (
              <Maximize2 className="h-3 w-3" />
            ) : (
              <Minimize2 className="h-3 w-3" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{toggleLabel}</TooltipContent>
      </Tooltip>

      <FilterPopover />

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleAddProject}
            disabled={isPickingDirectory}
            className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-[var(--sidebar-active)] hover:text-[var(--text-primary)] disabled:opacity-50"
            aria-label={t("addProject")}
          >
            <FolderPlus className="h-3 w-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{t("addProject")}</TooltipContent>
      </Tooltip>
    </div>
  );
}

function FilterPopover() {
  const { t } = useTranslation("common");
  const organizeMode = useSidebarStore((s) => s.organizeMode);
  const setOrganizeMode = useSidebarStore((s) => s.setOrganizeMode);
  const sortBy = useSidebarStore((s) => s.sortBy);
  const setSortBy = useSidebarStore((s) => s.setSortBy);

  const organizeOptions: Array<{
    value: OrganizeMode;
    label: string;
    icon: React.ReactNode;
  }> = [
    { value: "by-project", label: t("organizeByProject"), icon: <FolderClosed className="h-3.5 w-3.5" /> },
    { value: "chronological", label: t("organizeChronological"), icon: <Clock3 className="h-3.5 w-3.5" /> },
    { value: "chats-first", label: t("organizeChatsFirst"), icon: <MessageSquare className="h-3.5 w-3.5" /> },
  ];

  const sortOptions: Array<{ value: SortBy; label: string }> = [
    { value: "created", label: t("sortByCreated") },
    { value: "updated", label: t("sortByUpdated") },
  ];

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-[var(--sidebar-active)] hover:text-[var(--text-primary)] data-[state=open]:bg-[var(--sidebar-active)] data-[state=open]:text-[var(--text-primary)]"
              aria-label={t("filterSortOrganize")}
            >
              <ListFilter className="h-3 w-3" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{t("filterSortOrganize")}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-60 p-1"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <SectionLabel>{t("organize")}</SectionLabel>
        {organizeOptions.map((opt) => (
          <FilterRow
            key={opt.value}
            selected={organizeMode === opt.value}
            onClick={() => setOrganizeMode(opt.value)}
            icon={opt.icon}
            label={opt.label}
          />
        ))}
        <div className="my-1 h-px bg-[var(--border-subtle)]" />
        <SectionLabel>{t("organizeSortBy")}</SectionLabel>
        {sortOptions.map((opt) => (
          <FilterRow
            key={opt.value}
            selected={sortBy === opt.value}
            onClick={() => setSortBy(opt.value)}
            label={opt.label}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-1.5 text-ui-3xs font-semibold uppercase tracking-[0.12em] text-[var(--text-tertiary)]">
      {children}
    </div>
  );
}

function FilterRow({
  selected,
  onClick,
  icon,
  label,
}: {
  selected: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        "text-[var(--text-secondary)] hover:bg-[var(--sidebar-active)] hover:text-[var(--text-primary)]",
      )}
    >
      {icon && <span className="shrink-0 text-[var(--text-tertiary)]">{icon}</span>}
      <span className="flex-1 truncate">{label}</span>
      {selected && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--text-primary)]" />}
    </button>
  );
}
