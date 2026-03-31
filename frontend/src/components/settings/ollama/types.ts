export interface OllamaRuntimeStatus {
  binary_installed: boolean;
  running: boolean;
  port: number;
  base_url: string | null;
  version: string | null;
  models_dir: string | null;
  disk_usage_bytes: number;
}

export interface OllamaModel {
  name: string;
  size: number;
  digest: string;
  details?: {
    parameter_size?: string;
    quantization_level?: string;
    family?: string;
  };
}

export interface LibraryModel {
  name: string;
  category: string;
  sizes: string[];
  desc: string;
  provider: string;
  pulls?: number;
  pulls_formatted?: string;
  capabilities?: string[];
}

export interface LibraryData {
  categories: string[];
  models: LibraryModel[];
  has_more?: boolean;
  page?: number;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}
