import { BrowserRouter, Navigate, Routes, Route } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense } from "react";

import "./styles/globals.css";
import { ToastContainer } from "./components/toast/ToastContainer";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { LoadingOverlay } from "./components/ui/LoadingOverlay";
import { appQueryClient } from "./query/client";
import { useSettingsStore } from "./stores/settingsStore";

// 路由懒加载
const HomePage = lazy(() => import("./pages/HomePage").then(m => ({ default: m.HomePage })));
const ProjectsPage = lazy(() => import("./pages/ProjectsPage").then(m => ({ default: m.ProjectsPage })));
const ProjectPage = lazy(() => import("./pages/ProjectPage").then(m => ({ default: m.ProjectPage })));
const UniversesPage = lazy(() => import("./pages/UniversesPage").then(m => ({ default: m.UniversesPage })));
const UniverseDetailPage = lazy(() => import("./pages/UniverseDetailPage").then(m => ({ default: m.UniverseDetailPage })));
const SettingsModal = lazy(() => import("./components/settings/SettingsModal").then(m => ({ default: m.SettingsModal })));

function SettingsModalHost() {
  const isModalOpen = useSettingsStore((state) => state.isModalOpen);

  if (!isModalOpen) return null;

  return (
    <Suspense fallback={null}>
      <SettingsModal />
    </Suspense>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={appQueryClient}>
        <BrowserRouter>
          {/* Viewport host: pages fill this; no document scroll */}
          <div
            className="relative h-full max-h-dvh overflow-hidden bg-base-100"
            data-shell="app-root"
          >
            <Suspense
              fallback={
                <LoadingOverlay text="加载中…" className="fixed inset-0 z-modal" />
              }
            >
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/projects" element={<ProjectsPage />} />
                <Route path="/project/new" element={<Navigate to="/" replace />} />
                <Route path="/project/:id" element={<ProjectPage />} />
                <Route path="/projects/:id" element={<ProjectPage />} />
                <Route path="/universes" element={<UniversesPage />} />
                <Route path="/universes/:universeId" element={<UniverseDetailPage />} />
              </Routes>
            </Suspense>
          </div>
          <SettingsModalHost />
          <ToastContainer />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
