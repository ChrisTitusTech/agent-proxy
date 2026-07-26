import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from './theme/context';
import { AdminAuthProvider } from './auth/context';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AdminAuthProvider>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </AdminAuthProvider>
  </StrictMode>,
);
