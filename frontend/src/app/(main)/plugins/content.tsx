"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  Loader2,
  Plus,
  RotateCw,
  Sparkles,
  Star,
  Store,
  Unplug,
  Workflow,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { API, IS_DESKTOP, queryKeys } from "@/lib/constants";
import { desktopAPI } from "@/lib/tauri-api";
import {
  usePluginsStatus,
  usePluginDetail,
  usePluginToggle,
  useSkills,
  useSkillToggle,
  useSkillStoreSearch,
  useInstallSkill,
} from "@/hooks/use-plugins";
import {
  useConnectors,
  useConnectorToggle,
  useConnectorConnect,
  useConnectorDisconnect,
  useConnectorReconnect,
  useAddCustomConnector,
  useSetConnectorToken,
} from "@/hooks/use-connectors";
import type { PluginInfo, SkillInfo, StoreSkill } from "@/types/plugins";
import type { ConnectorInfo } from "@/types/connectors";

const SOURCE_COLORS: Record<string, string> = {
  builtin: "bg-blue-500/10 text-blue-400",
  global: "bg-amber-500/10 text-amber-400",
  project: "bg-emerald-500/10 text-emerald-400",
  plugin: "bg-purple-500/10 text-purple-400",
  bundled: "bg-blue-500/10 text-blue-400",
  custom: "bg-orange-500/10 text-orange-400",
};

/** Derive i18n key from category slug: "dev-tools" → "category_dev_tools" */
const categoryKey = (cat: string) => `category_${cat.replace(/-/g, "_")}`;

type Tab = "connectors" | "plugins" | "skills";

/* ------------------------------------------------------------------ */
/* Tab content (embedded in Settings)                                  */
/* ------------------------------------------------------------------ */

export function PluginsTabContent() {
  const { t } = useTranslation("plugins");
  const [tab, setTab] = useState<Tab>("connectors");
  const [search, setSearch] = useState("");

  return (
    <div className="space-y-4">
      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-[var(--border-default)]">
        {(["connectors", "plugins", "skills"] as Tab[]).map((tabKey) => (
          <button
            key={tabKey}
            onClick={() => { setTab(tabKey); setSearch(""); }}
            className={`px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
              tab === tabKey
                ? "border-[var(--text-primary)] text-[var(--text-primary)]"
                : "border-transparent text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
            }`}
          >
            {tabKey === "connectors"
              ? t("connectorsTab")
              : tabKey === "plugins"
                ? t("pluginsTab")
                : t("skills")}
          </button>
        ))}
      </div>

      {/* Search */}
      <div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("searchPlaceholder")}
          className="w-full h-8 rounded-md border border-[var(--border-default)] bg-transparent px-3 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--border-focus)]"
        />
      </div>

      {/* Content */}
      {tab === "connectors" ? (
        <ConnectorsTab search={search} />
      ) : tab === "plugins" ? (
        <PluginsTab search={search} />
      ) : (
        <SkillsTab search={search} />
      )}
    </div>
  );
}


/* ------------------------------------------------------------------ */
/* Connectors Tab                                                      */
/* ------------------------------------------------------------------ */

const STATUS_COLORS: Record<string, string> = {
  connected: "bg-emerald-500",
  needs_auth: "bg-amber-500",
  failed: "bg-red-500",
  disconnected: "bg-[var(--text-tertiary)]",
  disabled: "bg-[var(--text-tertiary)]",
};

function ConnectorsTab({ search }: { search: string }) {
  const { t } = useTranslation("plugins");
  const { data, isLoading } = useConnectors();
  const [showAdd, setShowAdd] = useState(false);

  const connectors = data?.connectors ?? {};
  const entries = Object.entries(connectors);
  const connectedCount = entries.filter(([, c]) => c.status === "connected").length;

  const filtered = search
    ? entries.filter(
        ([id, c]) =>
          id.toLowerCase().includes(search.toLowerCase()) ||
          c.name.toLowerCase().includes(search.toLowerCase()) ||
          c.description.toLowerCase().includes(search.toLowerCase()),
      )
    : entries;

  // Group by category
  const byCategory: Record<string, [string, ConnectorInfo][]> = {};
  for (const entry of filtered) {
    const cat = entry[1].category || "other";
    (byCategory[cat] ??= []).push(entry);
  }

  // Sort categories
  const categoryOrder = [
    "communication", "productivity", "dev-tools", "design", "crm",
    "analytics", "marketing", "sales", "data", "legal", "operations",
    "knowledge", "bio-research", "custom", "other",
  ];
  const sortedCategories = Object.keys(byCategory).sort(
    (a, b) => (categoryOrder.indexOf(a) ?? 99) - (categoryOrder.indexOf(b) ?? 99),
  );

  return (
    <>
      <div className="flex items-center justify-between mb-3">
        {!isLoading && (
          <p className="text-ui-2xs text-[var(--text-tertiary)]">
            {t("connectedCount", { count: connectedCount })} / {entries.length}
          </p>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-ui-2xs px-2.5"
          onClick={() => setShowAdd(!showAdd)}
        >
          <Plus className="h-3 w-3 mr-1" />
          {t("addCustom")}
        </Button>
      </div>

      {showAdd && <AddConnectorForm onClose={() => setShowAdd(false)} />}

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-14 rounded-lg bg-[var(--surface-tertiary)] animate-pulse"
            />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-[var(--text-tertiary)] text-center py-8">
          {t("noConnectors")}
        </p>
      ) : (
        <div className="space-y-5">
          {sortedCategories.map((cat) => (
            <div key={cat}>
              <h3 className="text-ui-2xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wider mb-2">
                {t(categoryKey(cat), cat)} ({byCategory[cat].length})
              </h3>
              <div className="space-y-1.5">
                {byCategory[cat].map(([id, connector]) => (
                  <ConnectorRow key={id} id={id} connector={connector} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function ConnectorRow({
  id,
  connector,
}: {
  id: string;
  connector: ConnectorInfo;
}) {
  const { t } = useTranslation("plugins");
  const toggle = useConnectorToggle();
  const connect = useConnectorConnect();
  const disconnect = useConnectorDisconnect();
  const reconnect = useConnectorReconnect();
  const setToken = useSetConnectorToken();
  const [tokenInput, setTokenInput] = useState("");

  const isPending =
    toggle.isPending || connect.isPending || disconnect.isPending || reconnect.isPending;

  const qc = useQueryClient();

  const handleConnect = async () => {
    // Google Workspace uses direct Google OAuth (not MCP OAuth)
    const isGoogle = id === "google-workspace";
    const result = isGoogle
      ? await api.post<{ success: boolean; auth_url?: string; state?: string; error?: string }>(API.GOOGLE.AUTH_START)
      : await connect.mutateAsync(id);

    if (result.success && result.auth_url) {
      if (IS_DESKTOP) {
        // Tauri: open system browser + poll for auth completion
        await desktopAPI.openExternal(result.auth_url);
        const poll = setInterval(async () => {
          await qc.invalidateQueries({ queryKey: queryKeys.connectors });
        }, 3000);
        // Stop polling after 5 minutes
        setTimeout(() => clearInterval(poll), 300_000);
      } else {
        // Web: open popup + listen for postMessage
        const popup = window.open(
          result.auth_url,
          "connector-auth",
          "width=600,height=700,menubar=no,toolbar=no",
        );
        const handler = (event: MessageEvent) => {
          if (
            event.data?.type === "connector-auth-complete" ||
            event.data?.type === "mcp-auth-complete"
          ) {
            window.removeEventListener("message", handler);
            qc.invalidateQueries({ queryKey: queryKeys.connectors });
          }
        };
        window.addEventListener("message", handler);
        if (popup) {
          const timer = setInterval(() => {
            if (popup.closed) {
              clearInterval(timer);
              window.removeEventListener("message", handler);
              // Also refresh in case auth completed before popup closed
              qc.invalidateQueries({ queryKey: queryKeys.connectors });
            }
          }, 1000);
        }
      }
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-lg border border-[var(--border-default)] p-2.5">
      {/* Status dot */}
      <span
        className={`h-2 w-2 rounded-full shrink-0 ${
          STATUS_COLORS[connector.status] ?? STATUS_COLORS.disconnected
        }`}
      />

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-[var(--text-primary)]">
            {connector.name}
          </span>
          {connector.type === "local" && id !== "google-workspace" && (
            <span className="text-ui-3xs px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400">
              {t("localSetup")}
            </span>
          )}
          {connector.source === "custom" && (
            <span className={`text-ui-3xs px-1.5 py-0.5 rounded-full ${SOURCE_COLORS.custom}`}>
              {t("custom")}
            </span>
          )}
          {connector.status === "connected" && connector.tools_count > 0 && (
            <span className="text-ui-3xs text-[var(--text-tertiary)]">
              {connector.tools_count} {t("tools")}
            </span>
          )}
        </div>
        <p className="text-ui-3xs text-[var(--text-tertiary)] truncate mt-0.5">
          {connector.description}
        </p>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-1.5 shrink-0">
        {connector.status === "needs_auth" && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-ui-3xs px-2"
            onClick={handleConnect}
            disabled={isPending}
          >
            {isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <ExternalLink className="h-3 w-3" />
            )}
            <span className="ml-1">{t("connect")}</span>
          </Button>
        )}

        {(connector.status === "needs_auth" || connector.status === "failed") && connector.enabled && (
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (tokenInput.trim()) {
                setToken.mutate({ id, token: tokenInput.trim() });
                setTokenInput("");
              }
            }}
          >
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder={t("tokenPatPlaceholder")}
              className="h-6 w-28 rounded border border-[var(--border-default)] bg-transparent px-1.5 text-ui-3xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--border-focus)]"
            />
            <Button
              type="submit"
              variant="outline"
              size="sm"
              className="h-6 text-ui-3xs px-2"
              disabled={!tokenInput.trim() || setToken.isPending}
            >
              {setToken.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "OK"}
            </Button>
          </form>
        )}

        {connector.status === "connected" && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-ui-3xs px-1.5 text-[var(--text-tertiary)]"
            onClick={() => disconnect.mutate(id)}
            disabled={isPending}
            title={t("disconnect")}
          >
            <Unplug className="h-3 w-3" />
          </Button>
        )}

        {connector.status === "failed" && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-ui-3xs px-2"
            onClick={() => reconnect.mutate(id)}
            disabled={isPending}
          >
            {isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RotateCw className="h-3 w-3" />
            )}
            <span className="ml-1">{t("retry")}</span>
          </Button>
        )}

        {/* Enable/disable toggle */}
        <Switch
          checked={connector.enabled}
          onCheckedChange={async (checked) => {
            await toggle.mutateAsync({ id, enable: checked });
            if (checked && (connector.type === "remote" || id === "google-workspace")) {
              // Remote or Google: auto-trigger OAuth after enable
              await new Promise((r) => setTimeout(r, 500));
              await qc.invalidateQueries({ queryKey: queryKeys.connectors });
              handleConnect();
            } else if (checked) {
              // Local: just refresh status
              await new Promise((r) => setTimeout(r, 1000));
              await qc.invalidateQueries({ queryKey: queryKeys.connectors });
            }
          }}
          disabled={toggle.isPending}
          className="shrink-0"
        />
      </div>
    </div>
  );
}

function AddConnectorForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("plugins");
  const addConnector = useAddCustomConnector();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !url) return;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    await addConnector.mutateAsync({ id, name, url });
    onClose();
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="mb-4 rounded-lg border border-[var(--border-default)] bg-[var(--surface-secondary)] p-3 space-y-2.5"
    >
      <h4 className="text-xs font-semibold text-[var(--text-primary)]">
        {t("addConnector")}
      </h4>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("connectorName")}
        className="w-full h-7 rounded-md border border-[var(--border-default)] bg-transparent px-2.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--border-focus)]"
        required
      />
      <input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://mcp.example.com/mcp"
        className="w-full h-7 rounded-md border border-[var(--border-default)] bg-transparent px-2.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--border-focus)]"
        required
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" className="h-7 text-ui-2xs" onClick={onClose} type="button">
          {t("cancel")}
        </Button>
        <Button size="sm" className="h-7 text-ui-2xs" type="submit" disabled={addConnector.isPending}>
          {addConnector.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
          {t("add")}
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Plugins Tab                                                         */
/* ------------------------------------------------------------------ */

function PluginsTab({ search }: { search: string }) {
  const { t } = useTranslation("plugins");
  const { data, isLoading } = usePluginsStatus();
  const [expanded, setExpanded] = useState<string | null>(null);

  const plugins = data?.plugins ?? {};
  const entries = Object.entries(plugins);
  const enabledCount = entries.filter(([, p]) => p.enabled).length;

  const filtered = search
    ? entries.filter(
        ([name, p]) =>
          name.toLowerCase().includes(search.toLowerCase()) ||
          p.description.toLowerCase().includes(search.toLowerCase()),
      )
    : entries;

  return (
    <>
      {!isLoading && (
        <p className="text-ui-2xs text-[var(--text-tertiary)] mb-3">
          {t("enabledCount", { count: enabledCount })} / {entries.length}
        </p>
      )}

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-16 rounded-lg bg-[var(--surface-tertiary)] animate-pulse"
            />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-[var(--text-tertiary)] text-center py-8">
          {t("noPlugins")}
        </p>
      ) : (
        <div className="space-y-2">
          {filtered.map(([name, plugin]) => (
            <PluginCard
              key={name}
              name={name}
              plugin={plugin}
              expanded={expanded === name}
              onToggleExpand={() =>
                setExpanded(expanded === name ? null : name)
              }
            />
          ))}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Skills Tab                                                          */
/* ------------------------------------------------------------------ */

function SkillsTab({ search }: { search: string }) {
  const { t } = useTranslation("plugins");
  const { data: skills, isLoading } = useSkills();
  const [storeOpen, setStoreOpen] = useState(false);

  const allSkills = skills ?? [];

  // Lowercased name set for fast "already installed?" lookups in the store.
  const installedNames = useMemo(
    () => new Set(allSkills.map((s) => s.name.toLowerCase())),
    [allSkills],
  );

  const bundled = allSkills.filter((s) => s.source === "bundled");
  const plugin = allSkills.filter((s) => s.source === "plugin");
  const project = allSkills.filter((s) => s.source === "project");

  const filterSkills = (list: SkillInfo[]) =>
    search
      ? list.filter(
          (s) =>
            s.name.toLowerCase().includes(search.toLowerCase()) ||
            s.description.toLowerCase().includes(search.toLowerCase()),
        )
      : list;

  const filteredBundled = filterSkills(bundled);
  const filteredPlugin = filterSkills(plugin);
  const filteredProject = filterSkills(project);

  const installedTotal =
    filteredBundled.length + filteredPlugin.length + filteredProject.length;

  return (
    <div className="space-y-6">
      {/* Store browser — collapsed by default */}
      <SkillStoreSection
        open={storeOpen}
        onToggle={() => setStoreOpen((v) => !v)}
        installedNames={installedNames}
      />

      {/* Installed skills */}
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-10 rounded-lg bg-[var(--surface-tertiary)] animate-pulse"
            />
          ))}
        </div>
      ) : installedTotal === 0 ? (
        <p className="text-xs text-[var(--text-tertiary)] text-center py-8">
          {t("noSkills")}
        </p>
      ) : (
        <>
          {filteredBundled.length > 0 && (
            <SkillGroup
              title={t("bundledSkills")}
              skills={filteredBundled}
              source="bundled"
            />
          )}
          {filteredPlugin.length > 0 && (
            <SkillGroup
              title={t("pluginSkills")}
              skills={filteredPlugin}
              source="plugin"
            />
          )}
          {filteredProject.length > 0 && (
            <SkillGroup
              title={t("projectSkills")}
              skills={filteredProject}
              source="project"
            />
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Skill Store (proxied from skillsmp.com)                             */
/* ------------------------------------------------------------------ */

function SkillStoreSection({
  open,
  onToggle,
  installedNames,
}: {
  open: boolean;
  onToggle: () => void;
  installedNames: Set<string>;
}) {
  const { t } = useTranslation("plugins");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [sort, setSort] = useState<"stars" | "recent">("stars");

  useEffect(() => {
    const h = setTimeout(() => setDebounced(query.trim()), 400);
    return () => clearTimeout(h);
  }, [query]);

  const { data, isFetching, isError, refetch } = useSkillStoreSearch(
    debounced,
    sort,
    1,
    /* enabled */ open,
  );
  const install = useInstallSkill();

  const results = data?.data?.skills ?? [];
  const total = data?.data?.pagination?.total ?? 0;

  const handleInstall = async (skill: StoreSkill) => {
    try {
      await install.mutateAsync({
        github_url: skill.githubUrl,
        name: skill.name,
      });
      toast.success(
        t("storeInstalled", {
          name: skill.name,
          defaultValue: `Installed ${skill.name}`,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Install failed";
      toast.error(msg);
    }
  };

  return (
    <div className="rounded-lg border border-[var(--border-default)]">
      {/* Header */}
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-[var(--text-tertiary)]" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-[var(--text-tertiary)]" />
        )}
        <Store className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
        <span className="text-xs font-semibold text-[var(--text-primary)]">
          {t("storeTitle", { defaultValue: "Browse skills" })}
        </span>
        <span className="text-ui-3xs text-[var(--text-tertiary)]">
          {t("storeSubtitle", {
            defaultValue: "curated from skillsmp.com — search & install",
          })}
        </span>
      </button>

      {open && (
        <div className="border-t border-[var(--border-default)] p-3 space-y-3">
          {/* Search + sort */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("storeSearchPlaceholder", {
                defaultValue: "Search 900k+ skills…",
              })}
              className="flex-1 h-8 rounded-md border border-[var(--border-default)] bg-transparent px-3 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--border-focus)]"
            />
            <div className="flex items-center rounded-md border border-[var(--border-default)] text-ui-2xs overflow-hidden">
              {(["stars", "recent"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSort(s)}
                  className={`px-2.5 py-1.5 transition-colors ${
                    sort === s
                      ? "bg-[var(--surface-tertiary)] text-[var(--text-primary)]"
                      : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                  }`}
                >
                  {s === "stars"
                    ? t("storeSortStars", { defaultValue: "Top" })
                    : t("storeSortRecent", { defaultValue: "Recent" })}
                </button>
              ))}
            </div>
          </div>

          {/* Results */}
          {isError ? (
            <div className="text-xs text-[var(--text-tertiary)] text-center py-4 space-y-2">
              <p>
                {t("storeUnavailable", {
                  defaultValue: "Skills store is unreachable.",
                })}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-ui-2xs"
                onClick={() => refetch()}
              >
                <RotateCw className="h-3 w-3 mr-1" />
                {t("retry", { defaultValue: "Retry" })}
              </Button>
            </div>
          ) : isFetching && results.length === 0 ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-14 rounded-lg bg-[var(--surface-tertiary)] animate-pulse"
                />
              ))}
            </div>
          ) : results.length === 0 ? (
            <p className="text-xs text-[var(--text-tertiary)] text-center py-4">
              {t("storeNoResults", {
                defaultValue: "No skills matched your search.",
              })}
            </p>
          ) : (
            <>
              <p className="text-ui-3xs text-[var(--text-tertiary)]">
                {t("storeResultCount", {
                  shown: results.length,
                  total,
                  defaultValue: `Showing ${results.length} of ${total}`,
                })}
              </p>
              <div className="space-y-1.5">
                {results.map((skill) => (
                  <StoreSkillRow
                    key={skill.id}
                    skill={skill}
                    installed={installedNames.has(skill.name.toLowerCase())}
                    installing={install.isPending && install.variables?.github_url === skill.githubUrl}
                    onInstall={() => handleInstall(skill)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function StoreSkillRow({
  skill,
  installed,
  installing,
  onInstall,
}: {
  skill: StoreSkill;
  installed: boolean;
  installing: boolean;
  onInstall: () => void;
}) {
  const { t } = useTranslation("plugins");
  return (
    <div className="flex items-start gap-3 rounded-lg border border-[var(--border-default)] p-2.5">
      <Sparkles className="h-3.5 w-3.5 text-[var(--text-tertiary)] mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono font-medium text-[var(--text-primary)] truncate">
            {skill.name}
          </span>
          <span className="text-ui-3xs text-[var(--text-tertiary)] truncate">
            by {skill.author}
          </span>
          {skill.stars > 0 && (
            <span className="inline-flex items-center gap-0.5 text-ui-3xs text-[var(--text-tertiary)]">
              <Star className="h-2.5 w-2.5" />
              {skill.stars}
            </span>
          )}
        </div>
        <p className="text-ui-2xs text-[var(--text-tertiary)] mt-0.5 line-clamp-2">
          {skill.description}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <a
          href={skill.githubUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="p-1 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
          title={t("storeViewOnGithub", { defaultValue: "View on GitHub" })}
        >
          <ExternalLink className="h-3 w-3" />
        </a>
        {installed ? (
          <span className="inline-flex items-center gap-1 text-ui-3xs text-[var(--text-tertiary)] px-2 py-1">
            <Check className="h-3 w-3" />
            {t("storeInstalledBadge", { defaultValue: "Installed" })}
          </span>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-ui-2xs px-2.5"
            disabled={installing}
            onClick={onInstall}
          >
            {installing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Download className="h-3 w-3" />
            )}
            <span className="ml-1">
              {t("storeInstall", { defaultValue: "Install" })}
            </span>
          </Button>
        )}
      </div>
    </div>
  );
}

function SkillGroup({
  title,
  skills,
  source,
}: {
  title: string;
  skills: SkillInfo[];
  source: string;
}) {
  const { t } = useTranslation("plugins");
  const toggle = useSkillToggle();

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-xs font-semibold text-[var(--text-secondary)]">
          {title}
        </h3>
        <span className="text-ui-3xs text-[var(--text-tertiary)]">
          ({skills.length})
        </span>
      </div>
      <div className="space-y-1">
        {skills.map((skill) => (
          <div
            key={skill.name}
            className="flex items-center gap-3 rounded-lg border border-[var(--border-default)] p-2.5"
          >
            <div className={`flex items-start gap-3 min-w-0 flex-1 ${!skill.enabled ? "opacity-50" : ""}`}>
              <Sparkles className="h-3.5 w-3.5 text-[var(--text-tertiary)] mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono font-medium text-[var(--text-primary)]">
                    {skill.name}
                  </span>
                  <span
                    className={`text-ui-3xs px-1.5 py-0.5 rounded-full ${
                      SOURCE_COLORS[source] ?? SOURCE_COLORS.bundled
                    }`}
                  >
                    {skill.name.includes(":") ? skill.name.split(":")[0] : t(source, source)}
                  </span>
                </div>
                <p className="text-ui-2xs text-[var(--text-tertiary)] mt-0.5 line-clamp-2">
                  {skill.description}
                </p>
              </div>
            </div>
            <Switch
              checked={skill.enabled}
              onCheckedChange={(checked) =>
                toggle.mutate({ name: skill.name, enable: checked })
              }
              disabled={toggle.isPending}
              className="shrink-0"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Plugin Card + Detail                                                */
/* ------------------------------------------------------------------ */

function PluginCard({
  name,
  plugin,
  expanded,
  onToggleExpand,
}: {
  name: string;
  plugin: PluginInfo;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const { t } = useTranslation("plugins");
  const toggle = usePluginToggle();

  return (
    <div className="rounded-lg border border-[var(--border-default)] overflow-hidden">
      {/* Main row */}
      <div className="flex items-center gap-3 p-3">
        <button
          onClick={onToggleExpand}
          className="shrink-0 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </button>

        <span
          className={`h-2 w-2 rounded-full shrink-0 ${
            plugin.enabled ? "bg-emerald-500" : "bg-[var(--text-tertiary)]"
          }`}
        />

        <div className="flex-1 min-w-0" onClick={onToggleExpand} role="button">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-[var(--text-primary)] truncate">
              {name}
            </p>
            <span className="text-ui-3xs text-[var(--text-tertiary)]">
              {t("version", { version: plugin.version })}
            </span>
            <span
              className={`text-ui-3xs px-1.5 py-0.5 rounded-full ${
                SOURCE_COLORS[plugin.source] ?? SOURCE_COLORS.builtin
              }`}
            >
              {t(plugin.source)}
            </span>
          </div>
          <p className="text-ui-2xs text-[var(--text-tertiary)] truncate mt-0.5">
            {plugin.description}
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0 text-ui-2xs text-[var(--text-tertiary)]">
          <span className="flex items-center gap-1">
            <Sparkles className="h-3 w-3" />
            {plugin.skills_count}
          </span>
          {plugin.mcp_count > 0 && (
            <span className="flex items-center gap-1">
              <Workflow className="h-3 w-3" />
              {plugin.mcp_count}
            </span>
          )}
        </div>

        <Switch
          checked={plugin.enabled}
          onCheckedChange={(checked) =>
            toggle.mutate({ name, enable: checked })
          }
          disabled={toggle.isPending}
          className="shrink-0"
        />
      </div>

      {expanded && <PluginDetailPanel name={name} />}
    </div>
  );
}

function PluginDetailPanel({ name }: { name: string }) {
  const { t } = useTranslation("plugins");
  const { data, isLoading } = usePluginDetail(name);
  const { data: connectorsData } = useConnectors();

  const connectors = connectorsData?.connectors ?? {};

  if (isLoading) {
    return (
      <div className="border-t border-[var(--border-default)] p-3">
        <div className="h-8 rounded bg-[var(--surface-tertiary)] animate-pulse" />
      </div>
    );
  }

  if (!data) return null;

  const connectorIds = data.connector_ids ?? [];

  return (
    <div className="border-t border-[var(--border-default)] bg-[var(--surface-secondary)] px-3 py-3">
      {/* Skills */}
      {data.skills.length > 0 && (
        <div className="mb-3">
          <h4 className="text-ui-2xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-2">
            {t("skills")} ({data.skills.length})
          </h4>
          <div className="space-y-1">
            {data.skills.map((skill) => (
              <div key={skill.name} className="flex gap-2">
                <span className="text-xs font-mono text-[var(--text-primary)] shrink-0">
                  {skill.name}
                </span>
                <span className="text-ui-2xs text-[var(--text-tertiary)] truncate">
                  {skill.description}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Required connectors */}
      {connectorIds.length > 0 && (
        <div>
          <h4 className="text-ui-2xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-2">
            {t("requiredConnectors")} ({connectorIds.length})
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {connectorIds.map((cid) => {
              const connector = connectors[cid];
              const statusColor = connector
                ? STATUS_COLORS[connector.status] ?? STATUS_COLORS.disconnected
                : STATUS_COLORS.disconnected;

              return (
                <span
                  key={cid}
                  className="inline-flex items-center gap-1.5 text-ui-2xs text-[var(--text-primary)] rounded border border-[var(--border-default)] bg-[var(--surface-primary)] px-2 py-1"
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${statusColor}`} />
                  {connector?.name ?? cid}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
