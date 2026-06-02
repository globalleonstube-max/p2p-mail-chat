import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Handle benign HMR websocket connection failures or closures in sandboxed preview environments
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    if (
      reason &&
      (reason === 'WebSocket closed without opened.' ||
        (typeof reason === 'string' && (reason.includes('WebSocket') || reason.includes('vite'))) ||
        (reason instanceof Error &&
          (reason.message?.includes('WebSocket') ||
            reason.message?.includes('vite') ||
            reason.stack?.includes('vite'))))
    ) {
      event.preventDefault();
      event.stopPropagation();
      console.warn('Suppressed benign Vite HMR websocket connection rejection:', reason);
    }
  });

  window.addEventListener('error', (event) => {
    const message = event.message;
    if (message && (message.includes('WebSocket') || message.includes('vite') || message.includes('ws://'))) {
      event.preventDefault();
      event.stopPropagation();
      console.warn('Suppressed benign Vite HMR websocket connection error:', message);
    }
  }, true);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
