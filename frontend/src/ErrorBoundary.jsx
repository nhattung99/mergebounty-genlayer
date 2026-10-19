import React from 'react';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error) {
    console.error('MergeBounty render error:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="crash">
          <h1>Trang gặp lỗi khi vẽ giao diện</h1>
          <p>Dữ liệu contract không làm sập toàn bộ ứng dụng. Tải lại để thử tiếp.</p>
          <pre>{String(this.state.error || '')}</pre>
          <button type="button" onClick={() => window.location.reload()}>Tải lại</button>
        </main>
      );
    }
    return this.props.children;
  }
}
