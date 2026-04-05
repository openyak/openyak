export interface TokenBreakdown {
  // Canonical semantics align with backend/app/api/usage.py TokenBreakdown.
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
}

export interface ModelUsage {
  model_id: string;
  provider_id: string;
  total_cost: number;
  total_tokens: TokenBreakdown;
  message_count: number;
}

export interface SessionUsage {
  session_id: string;
  title: string;
  total_cost: number;
  total_tokens: number;
  message_count: number;
  time_created: string;
}

export interface DailyUsage {
  date: string;
  cost: number;
  tokens: number;
  messages: number;
}

export interface ResponseTimeStats {
  avg: number;
  median: number;
  p95: number;
  min: number;
  max: number;
  count: number;
}

export interface UsageStats {
  total_cost: number;
  total_tokens: TokenBreakdown;
  total_sessions: number;
  total_messages: number;
  avg_tokens_per_session: number;
  avg_response_time: number;
  by_model: ModelUsage[];
  by_session: SessionUsage[];
  daily: DailyUsage[];
  response_time: ResponseTimeStats;
}

export interface ApiKeyStatus {
  is_configured: boolean;
  masked_key: string | null;
  is_valid: boolean | null;
}

export interface ProviderInfo {
  id: string;
  name: string;
  is_configured: boolean;
  enabled: boolean;
  masked_key: string | null;
  model_count: number;
  status: "connected" | "error" | "unconfigured" | "disabled";
  base_url?: string;
}

export interface LocalProviderStatus {
  base_url: string;
  is_configured: boolean;
  is_connected: boolean;
  status: "connected" | "error" | "unconfigured";
}
