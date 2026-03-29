export interface WorkspaceMemoryResponse {
  workspace_path: string;
  content: string;
  time_updated?: string | null;
}

export interface WorkspaceMemoryListItem {
  workspace_path: string;
  content: string;
  line_count: number;
  time_updated?: string | null;
}

export interface WorkspaceMemoryUpdate {
  workspace_path: string;
  content: string;
}
