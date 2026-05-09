import { Component, type ReactNode } from 'react';

interface Props { children: ReactNode; }
interface State { error: Error | null; }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          padding: '40px', textAlign: 'center', fontFamily: 'sans-serif', color: '#374151'
        }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>⚠️</div>
          <h2 style={{ marginBottom: 8 }}>页面出现错误</h2>
          <p style={{ color: '#6b7280', marginBottom: 24, fontSize: 14 }}>
            {this.state.error.message}
          </p>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              padding: '8px 20px', background: '#6366f1', color: '#fff',
              border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14
            }}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
