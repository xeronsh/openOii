// Toast 类型定义
type ToastType = "success" | "error" | "warning" | "info";

export interface ToastAction {
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary";
}

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message: string;
  duration: number; // 自动消失时间（ms），0 表示不自动消失
  actions?: ToastAction[];
  details?: string; // 开发模式下的详细信息
}

// API 错误类
export class ApiError extends Error {
  code: string;
  retryable: boolean;
  status?: number;
  details?: Record<string, unknown>;
  request?: {
    method?: string;
    url?: string;
  };
  response?: unknown;

  constructor(options: {
    code: string;
    message: string;
    retryable?: boolean;
    status?: number;
    details?: Record<string, unknown>;
    request?: { method?: string; url?: string };
    response?: unknown;
  }) {
    super(options.message);
    this.name = "ApiError";
    this.code = options.code;
    this.retryable = options.retryable ?? (
      options.code === "NETWORK_ERROR" ||
      [408, 429, 500, 502, 503, 504].includes(options.status ?? 0)
    );
    this.status = options.status;
    this.details = options.details;
    this.request = options.request;
    this.response = options.response;
  }
}
