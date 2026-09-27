import { useCallback, useEffect, useState } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { CommandPalette } from './components/CommandPalette';
import { HomePage } from './pages/HomePage';
import { SectionPage } from './pages/SectionPage';
import { TopicPage } from './pages/TopicPage';
import { ProgressPage } from './pages/ProgressPage';
import { PracticePage } from './pages/PracticePage';
import { RoadmapPage } from './pages/RoadmapPage';
import { CheatsheetsPage } from './pages/CheatsheetsPage';
import { TOTAL_TOPICS } from './lib/content';

function NotFound() {
  return (
    <div className="wrap">
      <div className="empty">
        <h3>Page not found</h3>
        <p>
          That route does not exist. Press <kbd>Ctrl</kbd> <kbd>K</kbd> to search the curriculum.
        </p>
      </div>
    </div>
  );
}

function EmptyContent() {
  return (
    <div className="wrap">
      <div className="empty">
        <h3>No content files found</h3>
        <p>
          Add markdown files under <code>src/content/&lt;section&gt;/NN-slug.md</code> and they will appear here
          automatically.
        </p>
      </div>
    </div>
  );
}

export default function App() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (e.key === '/' && !typing) {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openPalette = useCallback(() => setPaletteOpen(true), []);

  return (
    <div className="app">
      <Header
        onOpenPalette={openPalette}
        onToggleSidebar={() => setSidebarOpen((s) => !s)}
        sidebarOpen={sidebarOpen}
      />
      <div className="shell">
        <Sidebar open={sidebarOpen} onNavigate={() => setSidebarOpen(false)} />
        {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}
        <main className="main">
          {TOTAL_TOPICS === 0 ? (
            <EmptyContent />
          ) : (
            <Routes>
              <Route path="/" element={<HomePage onOpenPalette={openPalette} />} />
              <Route path="/section/:section" element={<SectionPage />} />
              <Route path="/topic/:section/:slug" element={<TopicPage />} />
              <Route path="/progress" element={<ProgressPage />} />
              <Route path="/practice" element={<PracticePage />} />
              <Route path="/revise" element={<CheatsheetsPage />} />
              <Route path="/roadmap" element={<RoadmapPage />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          )}
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
