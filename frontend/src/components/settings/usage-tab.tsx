"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Coins,
  Zap,
  MessageSquare,
  Clock,
  Hash,
  Timer,
  AlertTriangle,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { OpenYakLogo } from "@/components/ui/openyak-logo";
import { useUsage } from "@/hooks/use-usage";
import { getChatRoute } from "@/lib/routes";
import { proxyApi } from "@/lib/proxy-api";
import { useAuthStore } from "@/stores/auth-store";
import type { UsageStats, TokenBreakdown } from "@/types/usage";

// --- Helpers ---

function formatCost(cost: number, tokens: number = 0): string {
  if (cost === 0 && tokens > 0) {
    return "\u2014";
  }
  const credits = cost * 100;
  if (credits === 0) return "0 cr";
  if (credits < 0.1) return `${credits.toFixed(2)} cr`;
  if (credits < 1) return `${credits.toFixed(1)} cr`;
  return `${credits.toFixed(1)} cr`;
}

function formatTokens(count: number): string {
  if (count === 0) return "0";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return count.toLocaleString();
}

function formatQuotaTokens(count: number): string {
  if (count === 0) return "0";
  if (count >= 1_000_000) {
    const value = (count / 1_000_000).toFixed(1);
    return `${value.endsWith(".0") ? value.slice(0, -2) : value}M`;
  }
  if (count >= 1_000) return `${(count / 1_000).toFixed(0)}K`;
  return count.toLocaleString();
}

function formatTime(seconds: number): string {
  if (seconds === 0) return "0s";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs.toFixed(0)}s`;
}

function formatModelName(modelId: string): string {
  const parts = modelId.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : modelId;
}

function tokenTotal(t: TokenBreakdown): number {
  return t.input + t.output + t.reasoning;
}

interface BalanceData {
  credits: number;
  usd_equivalent: number;
  daily_free_tokens_used: number;
  daily_free_token_limit: number;
}

type TrendMetric = "cost" | "tokens";

// --- Summary Card ---

function SummaryCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-[var(--border-default)] p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon className="h-4 w-4 text-[var(--text-tertiary)]" />
        <span className="text-xs text-[var(--text-tertiary)] uppercase tracking-wider">
          {label}
        </span>
      </div>
      <p className="text-2xl font-semibold text-[var(--text-primary)] font-mono">
        {value}
      </p>
      {sub && (
        <p className="text-xs text-[var(--text-tertiary)] mt-1">{sub}</p>
      )}
    </div>
  );
}

function FreeQuotaCard({
  balance,
  t,
}: {
  balance: BalanceData;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const used = balance.daily_free_tokens_used;
  const limit = balance.daily_free_token_limit;
  const remaining = Math.max(0, limit - used);
  const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const isHighUsage = percent >= 85;

  return (
    <div className="rounded-xl border border-[var(--border-default)] p-4 md:col-span-2">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <OpenYakLogo size={14} className="text-[var(--text-tertiary)]" />
          <span className="text-xs text-[var(--text-tertiary)] uppercase tracking-wider">
            {t("freeDailyQuota")}
          </span>
        </div>
        <span className="text-[11px] text-[var(--text-secondary)] font-mono">
          {formatQuotaTokens(used)} / {formatQuotaTokens(limit)}
        </span>
      </div>
      <div className="w-full bg-[var(--surface-tertiary)] rounded-full h-2 mb-2">
        <div
          className="h-2 rounded-full transition-all"
          style={{
            width: `${percent}%`,
            backgroundColor:
              percent >= 90
                ? "var(--color-destructive)"
                : percent >= 70
                  ? "var(--color-warning)"
                  : "var(--brand-primary)",
          }}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-[var(--text-secondary)]">
          {isHighUsage
            ? t("quotaHighUsage", {
                used: formatQuotaTokens(used),
                limit: formatQuotaTokens(limit),
              })
            : t("quotaRemaining", { remaining: formatQuotaTokens(remaining) })}
        </p>
        <p className="text-[11px] text-[var(--text-tertiary)] whitespace-nowrap">
          {t("resetsAtUtc")}
        </p>
      </div>
    </div>
  );
}

function KeyInsights({
  data,
  balance,
  t,
}: {
  data: UsageStats;
  balance: BalanceData | undefined;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const topModel = data.by_model[0];
  const totalCost = data.by_model.reduce((sum, m) => sum + m.total_cost, 0);
  const topCostShare = topModel && totalCost > 0 ? (topModel.total_cost / totalCost) * 100 : 0;
  const quotaPercent =
    balance && balance.daily_free_token_limit > 0
      ? (balance.daily_free_tokens_used / balance.daily_free_token_limit) * 100
      : 0;
  const showQuotaWarning = quotaPercent >= 85;

  return (
    <div className="rounded-xl border border-[var(--border-default)] p-4 space-y-2">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-[var(--text-tertiary)]" />
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t("keyInsights")}</h2>
      </div>
      {topModel && topCostShare > 0 && (
        <p className="text-sm text-[var(--text-secondary)]">
          {t("topModelInsight", {
            model: formatModelName(topModel.model_id),
            percent: `${topCostShare.toFixed(0)}%`,
          })}
        </p>
      )}
      {showQuotaWarning && (
        <div className="flex items-center gap-2 text-xs text-[var(--color-warning)]">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>
            {t("quotaHighUsage", {
              used: formatQuotaTokens(balance?.daily_free_tokens_used ?? 0),
              limit: formatQuotaTokens(balance?.daily_free_token_limit ?? 0),
            })}
          </span>
        </div>
      )}
    </div>
  );
}

// --- Token Breakdown Bar ---

function TokenBreakdownBar({ tokens }: { tokens: TokenBreakdown }) {
  const { t } = useTranslation('usage');
  const total = tokenTotal(tokens);
  if (total === 0) return null;

  const segments = [
    { label: t('input'), value: tokens.input, color: "var(--brand-primary)" },
    { label: t('output'), value: tokens.output, color: "var(--color-success)" },
    { label: t('reasoning'), value: tokens.reasoning, color: "var(--color-warning)" },
  ].filter((s) => s.value > 0);

  return (
    <div>
      <div className="flex h-6 rounded-lg overflow-hidden">
        {segments.map((seg) => (
          <div
            key={seg.label}
            className="transition-all"
            style={{
              width: `${(seg.value / total) * 100}%`,
              backgroundColor: seg.color,
              opacity: 0.8,
            }}
          />
        ))}
      </div>
      <div className="flex gap-4 mt-2">
        {segments.map((seg) => (
          <div key={seg.label} className="flex items-center gap-1.5 text-xs">
            <div
              className="h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: seg.color, opacity: 0.8 }}
            />
            <span className="text-[var(--text-secondary)]">{seg.label}</span>
            <span className="text-[var(--text-tertiary)] font-mono">
              {formatTokens(seg.value)} ({((seg.value / total) * 100).toFixed(0)}%)
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Custom Tooltip for Recharts ---

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-primary)] px-3 py-2 shadow-[var(--shadow-md)]">
      <p className="text-xs font-medium text-[var(--text-primary)] mb-1">{label}</p>
      {payload.map((entry: any) => (
        <p key={entry.name} className="text-xs text-[var(--text-secondary)]">
          {entry.name === "cost" ? formatCost(entry.value) : `${formatTokens(entry.value)} tokens`}
        </p>
      ))}
    </div>
  );
}

// --- Daily Trend Chart ---

function DailyTrendChart({
  data,
  metric,
}: {
  data: UsageStats["daily"];
  metric: TrendMetric;
}) {
  if (data.length === 0) return null;
  const isCost = metric === "cost";

  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="colorCost" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--brand-primary)" stopOpacity={0.3} />
              <stop offset="95%" stopColor="var(--brand-primary)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
            tickFormatter={(v: string) => v.slice(5)}
          />
          <YAxis
            tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
            tickFormatter={(v: number) => (isCost ? formatCost(v) : formatTokens(v))}
            width={50}
          />
          <Tooltip content={<ChartTooltip />} />
          <Area
            type="monotone"
            dataKey={metric}
            stroke="var(--brand-primary)"
            fill="url(#colorCost)"
            strokeWidth={2}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// --- Loading Skeleton ---

export function UsageSkeleton() {
  return (
    <div
      className="space-y-8 animate-fade-in"
      style={{ animationDelay: "150ms", animationFillMode: "backwards" }}
    >
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-6 w-full rounded-lg" />
      <Skeleton className="h-48 w-full rounded-xl" />
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  );
}

// --- Main Component ---

export function UsageTab() {
  const { t } = useTranslation('usage');
  const [days, setDays] = useState(30);
  const [trendMetric, setTrendMetric] = useState<TrendMetric>("cost");
  const { isConnected } = useAuthStore();
  const { data, isLoading, error } = useUsage(days);
  const { data: balance } = useQuery({
    queryKey: ["billing", "balance"],
    queryFn: () => proxyApi.get<BalanceData>("/api/billing/balance"),
    enabled: isConnected,
    refetchInterval: 30_000,
  });

  return (
    <div>
      {/* Period selector */}
      <div className="flex justify-end mb-6">
        <div className="flex gap-1">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                days === d
                  ? "bg-[var(--brand-primary)] text-[var(--brand-primary-text)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)]"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {isLoading && <UsageSkeleton />}

      {error && (
        <div className="text-sm text-[var(--color-destructive)] text-center py-12">
          {t('failedLoad')}
        </div>
      )}

      {data && data.total_messages === 0 && (
        <div className="text-center py-20">
          <Zap className="h-10 w-10 text-[var(--text-tertiary)] mx-auto mb-3" />
          <p className="text-sm text-[var(--text-secondary)]">
            {t('noUsageData')}
          </p>
        </div>
      )}

      {data && data.total_messages > 0 && (
        <div className="space-y-8">
          <section>
            <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
              {t("overview")}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              {balance && <FreeQuotaCard balance={balance} t={t} />}
              <SummaryCard
                icon={Coins}
                label={t("totalCost")}
                value={formatCost(data.total_cost)}
              />
              <SummaryCard
                icon={Zap}
                label={t("totalTokens")}
                value={formatTokens(tokenTotal(data.total_tokens))}
                sub={t("avgPerSession", { value: formatTokens(data.avg_tokens_per_session) })}
              />
              <SummaryCard
                icon={Timer}
                label={t("avgResponse")}
                value={formatTime(data.avg_response_time)}
                sub={
                  data.response_time.count > 0
                    ? `p95: ${formatTime(data.response_time.p95)}`
                    : undefined
                }
              />
              <SummaryCard
                icon={Hash}
                label={t("sessions")}
                value={data.total_sessions.toLocaleString()}
              />
              <SummaryCard
                icon={MessageSquare}
                label={t("messages")}
                value={data.total_messages.toLocaleString()}
              />
              <SummaryCard
                icon={Clock}
                label={t("responseTime")}
                value={
                  data.response_time.count > 0
                    ? `${formatTime(data.response_time.min)} \u2013 ${formatTime(data.response_time.max)}`
                    : "N/A"
                }
                sub={
                  data.response_time.count > 0
                    ? `median: ${formatTime(data.response_time.median)}`
                    : undefined
                }
              />
            </div>
          </section>

          <Separator />

          <KeyInsights data={data} balance={balance} t={t} />

          <Separator />

          <section>
            <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
              {t("tokenBreakdown")}
            </h2>
            <TokenBreakdownBar tokens={data.total_tokens} />
          </section>

          <Separator />

          {data.daily.length > 0 && (
            <>
              <section>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                    {t("dailyTrend")}
                  </h2>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => setTrendMetric("cost")}
                      className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                        trendMetric === "cost"
                          ? "bg-[var(--brand-primary)] text-[var(--brand-primary-text)]"
                          : "text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)]"
                      }`}
                    >
                      {t("trendMetricCredits")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setTrendMetric("tokens")}
                      className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                        trendMetric === "tokens"
                          ? "bg-[var(--brand-primary)] text-[var(--brand-primary-text)]"
                          : "text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)]"
                      }`}
                    >
                      {t("trendMetricTokens")}
                    </button>
                  </div>
                </div>
                <DailyTrendChart data={data.daily} metric={trendMetric} />
              </section>
              <Separator />
            </>
          )}

          {data.by_model.length > 0 && (
            <>
              <section>
                <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
                  {t("modelUsage")}
                </h2>
                <div className="rounded-xl border border-[var(--border-default)] overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-[var(--surface-secondary)]">
                        <th className="text-left px-3 py-2 font-medium text-[var(--text-tertiary)]">
                          {t("model")}
                        </th>
                        <th className="text-right px-3 py-2 font-medium text-[var(--text-tertiary)]">
                          {t("cost")}
                        </th>
                        <th className="text-right px-3 py-2 font-medium text-[var(--text-tertiary)]">
                          {t("tokens")}
                        </th>
                        <th className="text-right px-3 py-2 font-medium text-[var(--text-tertiary)]">
                          {t("messages")}
                        </th>
                        <th className="text-right px-3 py-2 font-medium text-[var(--text-tertiary)]">
                          {t("modelShare")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        const totalModelCost = data.by_model.reduce(
                          (sum, item) => sum + item.total_cost,
                          0,
                        );
                        const totalModelTokens = data.by_model.reduce(
                          (sum, item) =>
                            sum +
                            item.total_tokens.input +
                            item.total_tokens.output +
                            item.total_tokens.reasoning,
                          0,
                        );
                        return data.by_model.map((m, idx) => {
                          const modelTokens =
                            m.total_tokens.input +
                            m.total_tokens.output +
                            m.total_tokens.reasoning;
                          const share =
                            totalModelCost > 0
                              ? (m.total_cost / totalModelCost) * 100
                              : totalModelTokens > 0
                                ? (modelTokens / totalModelTokens) * 100
                                : 0;
                          return (
                            <tr
                              key={`${m.model_id}-${idx}`}
                              className="border-t border-[var(--border-default)]"
                            >
                              <td className="px-3 py-2 text-[var(--text-primary)] font-mono truncate max-w-[220px]">
                                {formatModelName(m.model_id)}
                              </td>
                              <td className="px-3 py-2 text-right text-[var(--text-secondary)] font-mono">
                                {formatCost(m.total_cost, modelTokens)}
                              </td>
                              <td className="px-3 py-2 text-right text-[var(--text-secondary)] font-mono">
                                {formatTokens(modelTokens)}
                              </td>
                              <td className="px-3 py-2 text-right text-[var(--text-secondary)] font-mono">
                                {m.message_count}
                              </td>
                              <td className="px-3 py-2 text-right">
                                <div className="flex items-center justify-end gap-2">
                                  <div className="w-14 h-1.5 rounded-full bg-[var(--surface-tertiary)] overflow-hidden">
                                    <div
                                      className="h-full bg-[var(--brand-primary)]"
                                      style={{ width: `${Math.min(100, share)}%` }}
                                    />
                                  </div>
                                  <span className="text-[10px] text-[var(--text-tertiary)] font-mono w-9 text-right">
                                    {share.toFixed(0)}%
                                  </span>
                                </div>
                              </td>
                            </tr>
                          );
                        });
                      })()}
                    </tbody>
                  </table>
                </div>
              </section>
              <Separator />
            </>
          )}

          {data.by_session.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
                {t("topSessions")}
              </h2>
              <div className="space-y-2">
                {data.by_session.map((s) => (
                  <Link
                    key={s.session_id}
                    href={getChatRoute(s.session_id)}
                    className="flex items-center justify-between rounded-lg border border-[var(--border-default)] px-3 py-2.5 hover:bg-[var(--surface-secondary)] transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-[var(--text-primary)] truncate">
                        {s.title}
                      </p>
                      <p className="text-xs text-[var(--text-tertiary)]">
                        {s.message_count} {t("messages").toLowerCase()} · {formatTokens(s.total_tokens)}{" "}
                        {t("tokens").toLowerCase()}
                      </p>
                    </div>
                    <span className="text-sm font-mono text-[var(--text-secondary)] ml-3 shrink-0">
                      {formatCost(s.total_cost)}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
