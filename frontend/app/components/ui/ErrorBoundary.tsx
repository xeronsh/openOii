import { Component, type ReactNode } from "react";
import { Button } from "./Button";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex min-h-screen items-center justify-center bg-base-100 p-3">
          <div className="card-doodle max-w-md p-4 text-center shadow-brutal-sm sm:p-5">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-error/10">
              <svg
                className="h-6 w-6 text-error"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>
            <h2 className="mb-1 font-heading text-lg font-bold">
              出错了
            </h2>
            <p className="mb-3 text-sm text-base-content/75">
              应用遇到了意外错误，请尝试刷新页面。
            </p>
            {this.state.error && (
              <details className="mb-3 rounded-md bg-base-200 p-2 text-left text-2xs">
                <summary className="mb-1 cursor-pointer font-medium">
                  错误详情
                </summary>
                <pre className="overflow-auto text-error">
                  {this.state.error.message}
                </pre>
              </details>
            )}
            <div className="flex justify-center gap-2">
              <Button variant="primary" size="sm" onClick={this.handleReset}>
                重试
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => window.location.reload()}
              >
                刷新页面
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
