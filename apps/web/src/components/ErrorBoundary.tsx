import { Component, type ReactNode } from 'react';

type ErrorBoundaryProps = { children: ReactNode };
type ErrorBoundaryState = { failed: boolean };

/**
 * 应用级渲染兜底（复用自 frontend-v2）：子组件 render 抛错时展示可读的中文提示与刷新入口，
 * 避免根节点整页空白，同时不暴露内部堆栈信息。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  private handleRefresh = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
        data-testid="app-error-boundary"
        className="flex min-h-dvh w-full flex-col items-center justify-center gap-4 bg-[#070812] p-6 text-center text-[#f8fafc]"
      >
        <p className="m-0 text-lg font-bold">页面暂时无法显示</p>
        <p className="m-0 text-sm text-[#c3cde0]">页面遇到意外问题，请刷新后重试。</p>
        <button
          type="button"
          onClick={this.handleRefresh}
          className="min-h-[44px] rounded-[10px] border border-[#3a4668] bg-transparent px-4 py-2 text-sm text-[#f8fafc] cursor-pointer hover:border-[#e0b64a]"
        >
          刷新页面
        </button>
      </div>
    );
  }
}

export default ErrorBoundary;
