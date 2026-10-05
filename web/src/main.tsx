import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PreferencesProvider } from './hooks/usePreferences';
import './styles/index.css';

const container = document.getElementById('root');
if (!container) throw new Error('找不到挂载点 #root');

createRoot(container).render(
  <StrictMode>
    <PreferencesProvider>
      <App />
    </PreferencesProvider>
  </StrictMode>,
);
