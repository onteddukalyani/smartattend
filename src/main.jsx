import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './theme.css'
import App from './App.jsx'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from './components/authcontext.jsx'

// Initialize theme from localStorage immediately on startup
const savedTheme = localStorage.getItem("smartattend-theme") || "light";
document.documentElement.dataset.theme = savedTheme;

createRoot(document.getElementById('root')).render(
    <BrowserRouter>
    <AuthProvider>
      <App/>
    </AuthProvider>
    </BrowserRouter>
)
