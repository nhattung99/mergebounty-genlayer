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
          <h1>This page hit a rendering error</h1>
          <p>The error was caught so the rest of the app does not go blank. Reload to try again.</p>
          <pre>{String(this.state.error || '')}</pre>
          <button type="button" onClick={() => window.location.reload()}>Reload</button>
        </main>
      );
    }
    return this.props.children;
  }
}
