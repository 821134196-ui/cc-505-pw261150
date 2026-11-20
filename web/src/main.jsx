import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './App.jsx';
import { AppProvider } from './lib/store.jsx';
import { DashboardPage } from './pages/DashboardPage.jsx';
import { AnomalyPage } from './pages/AnomalyPage.jsx';
import { VersionsPage } from './pages/VersionsPage.jsx';
import { ConcurrencyPage } from './pages/ConcurrencyPage.jsx';
import { AuditPage } from './pages/AuditPage.jsx';
import { Empty } from './components/ui.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<DashboardPage />} />
            <Route path="anomalies" element={<AnomalyPage />} />
            <Route path="versions" element={<VersionsPage />} />
            <Route path="concurrency" element={<ConcurrencyPage />} />
            <Route path="audit" element={<AuditPage />} />
            <Route path="*" element={<Empty title="页面不存在" hint="请从左侧导航选择一个页面。" />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AppProvider>
  </React.StrictMode>,
);
