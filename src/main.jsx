import { StrictMode, Component } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './theme.css'
import App from './App.jsx'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from './components/authcontext.jsx'

// Initialize theme safely without crashing if localStorage is restricted
try {
  const savedTheme = localStorage.getItem("smartattend-theme") || "light";
  document.documentElement.dataset.theme = savedTheme;
} catch (_) {
  document.documentElement.dataset.theme = "light";
}

// Emergency Error Boundary to prevent silent blank/white screen on mobile
class RootErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error("[RootErrorBoundary] Caught fatal error:", error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh',
          backgroundColor: '#0f172a',
          color: '#f8fafc',
          padding: '28px 20px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
        }}>
          <div style={{
            maxWidth: '440px',
            width: '100%',
            background: 'rgba(30, 41, 59, 0.9)',
            border: '1.5px solid rgba(239, 68, 68, 0.4)',
            borderRadius: '16px',
            padding: '24px',
            boxShadow: '0 10px 30px rgba(0, 0, 0, 0.4)'
          }}>
            <h3 style={{ color: '#ef4444', margin: '0 0 10px' }}>⚠️ SmartAttend Initialization Issue</h3>
            <p style={{ fontSize: '0.9rem', color: '#94a3b8', margin: '0 0 16px', lineHeight: 1.5 }}>
              The application encountered an issue during startup. Please tap reload to restart the app.
            </p>
            <pre style={{
              background: '#090d16',
              color: '#fca5a5',
              padding: '12px',
              borderRadius: '8px',
              fontSize: '0.78rem',
              overflowX: 'auto',
              textAlign: 'left',
              margin: '0 0 18px',
              whiteSpace: 'pre-wrap'
            }}>
              {this.state.error?.message || String(this.state.error)}
            </pre>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                width: '100%',
                padding: '12px',
                background: '#3b82f6',
                color: '#ffffff',
                border: 'none',
                borderRadius: '10px',
                fontWeight: 700,
                fontSize: '0.92rem',
                cursor: 'pointer'
              }}
            >
              🔄 Reload SmartAttend
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <RootErrorBoundary>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </RootErrorBoundary>
)

