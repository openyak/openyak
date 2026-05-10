/** Chat request/response schemas — mirrors backend app/schemas/chat.py */

/** Metadata returned by the upload endpoint, sent with the prompt. */
export interface FileAttachment {
  file_id: string;
  name: string;
  path: string;
  size: number;
  mime_type: string;
  source?: "referenced" | "uploaded";
  content_hash?: string;
}

export interface PromptRequest {
  session_id?: string | null;
  text: string;
  model?: string | null;
  provider_id?: string | null;
  agent?: string;
  attachments?: FileAttachment[];
  permission_presets?: Record<string, boolean> | null;
  permission_rules?: Array<{ action: "allow" | "deny"; permission: string; pattern?: string }> | null;
  reasoning?: boolean | null;
  workspace?: string | null;
}

export interface PromptResponse {
  stream_id: string;
  session_id: string;
}

export interface EditAndResendRequest {
  session_id: string;
  message_id: string;
  text: string;
  model?: string | null;
  provider_id?: string | null;
  agent?: string;
  attachments?: FileAttachment[];
  permission_presets?: Record<string, boolean> | null;
  permission_rules?: Array<{ action: "allow" | "deny"; permission: string; pattern?: string }> | null;
  reasoning?: boolean | null;
  workspace?: string | null;
}

export interface AbortRequest {
  stream_id: string;
}

export interface RespondRequest {
  stream_id: string;
  call_id: string;
  response: unknown;
}
