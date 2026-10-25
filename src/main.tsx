import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';
import './usage-notices.css';
import './workspace.css';
import './terminal.css';
import './sessions.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
