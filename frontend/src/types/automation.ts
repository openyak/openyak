/** Automation (scheduled task) types. */

export interface ScheduleConfig {
  type: "cron" | "interval";
  cron?: string;
  hours?: number;
  minutes?: number;
}

export interface AutomationResponse {
  id: string;
  name: string;
  description: string;
  prompt: string;
  schedule_config: ScheduleConfig | null;
  agent: string;
  model: string | null;
  workspace: string | null;
  enabled: boolean;
  template_id: string | null;
  last_run_at: string | null;
  last_run_status: string | null;
  last_session_id: string | null;
  next_run_at: string | null;
  run_count: number;
  timeout_seconds: number;
  loop_max_iterations: number | null;
  loop_preset: string | null;
  loop_stop_marker: string | null;
  time_created: string;
  time_updated: string;
}

export interface AutomationCreate {
  name: string;
  description?: string;
  prompt: string;
  schedule_config?: ScheduleConfig | null;
  agent?: string;
  model?: string | null;
  workspace?: string | null;
  template_id?: string | null;
  timeout_seconds?: number;
  loop_max_iterations?: number | null;
  loop_preset?: string | null;
}

export interface AutomationUpdate {
  name?: string;
  description?: string;
  prompt?: string;
  schedule_config?: ScheduleConfig;
  agent?: string;
  model?: string | null;
  workspace?: string | null;
  enabled?: boolean;
  timeout_seconds?: number;
  loop_max_iterations?: number | null;
  loop_preset?: string | null;
}

export interface TaskRunResponse {
  id: string;
  task_id: string;
  session_id: string | null;
  status: string;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  triggered_by: string;
  time_created: string;
}

export interface TemplateResponse {
  id: string;
  name: string;
  description: string;
  prompt: string;
  schedule_config: ScheduleConfig | null;
  category: string;
  icon: string;
  loop_max_iterations?: number | null;
  loop_preset?: string | null;
}
