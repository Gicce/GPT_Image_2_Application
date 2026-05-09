export interface Settings {
  token: string;
  default_size: string;
  default_quality: string;
  default_format: string;
  default_output_dir: string;
  chat_token: string;
  chat_model: string;
  chat_base_url: string;
  chat_system_prompt: string;
  server_url: string;
}

export interface SubTask {
  index: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  image_id?: string;
  error?: string | null;
}

export interface Task {
  id: string;
  prompt: string;
  negative_prompt: string;
  size: string;
  quality: string;
  output_format: string;
  count: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  created_at: string;
  output_dir: string;
  success_count: number;
  failed_count: number;
  sub_tasks: SubTask[];
  task_type: 'generate' | 'edit' | '';
  source_images: string[];
}

export interface ImageRecord {
  id: string;
  task_id: string;
  local_path: string;
  file_name: string;
  created_at: string;
  status: string;
}

export interface CreateTaskParams {
  prompt: string;
  negative_prompt: string;
  size: string;
  quality: string;
  output_format: string;
  count: number;
  output_dir: string;
  task_type: 'generate' | 'edit' | '';
  source_images: string[];
}

export type PageType = 'create' | 'edit' | 'chat' | 'queue' | 'gallery' | 'history' | 'settings' | 'about' | 'account';

// Chat types
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  images?: string[];
  reasoning?: string;
  reasoning_duration?: string;
  generated_image?: string;
  created_at: string;
}

export interface ChatConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  created_at: string;
}

export const SIZES = ['1024x1024', '1792x1024', '1024x1792'] as const;
export const QUALITIES = ['auto', 'high', 'medium', 'low'] as const;

export const QUALITY_LABELS: Record<string, string> = {
  auto: '自动（默认）',
  high: '高质量',
  medium: '中等质量',
  low: '低质量',
};
export const FORMATS = ['png', 'jpeg', 'webp'] as const;
