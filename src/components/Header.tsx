import { useEffect, useRef, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { ACCENTS, useTheme } from '../lib/theme';
import { IconSearch, IconSun, IconMoon, IconSettings, IconMenu, IconX } from './Icons';

export function Header({
  onOpenPalette,
  onToggleSidebar,
  sidebarOpen,
}: {
  onOpenPalette: () => void;
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
}) {
  const { theme, toggleTheme, accent, setAccent, font, setFont } = useTheme();
  const [settings, setSettings] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!settings) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setSettings(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && setSettings(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [settings]);

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <header className="header">
      <button className="btn btn-ghost btn-icon menu-btn" onClick={onToggleSidebar} aria-label="Toggle navigation">
        {sidebarOpen ? <IconX size={18} /> : <IconMenu size={18} />}
      </button>

      <Link to="/" className="brand">
        <span className="brand-mark">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3 3 7.5 12 12l9-4.5L12 3Z" />
            <path d="m3 12.5 9 4.5 9-4.5M3 17l9 4.5 9-4.5" />
          </svg>
        </span>
        <span className="brand-text">
          <span style={{ display: 'block', lineHeight: 1.15 }}>Interview Prep</span>
          <span className="brand-sub">Senior Engineer</span>
        </span>
      </Link>

      <div className="header-spacer" />

      <button className="search-trigger" onClick={onOpenPalette} type="button" aria-label="Search topics">
        <IconSearch size={15} />
        <span className="st-label">Search everything…</span>
        <span className="st-kbd">
          <kbd>{isMac ? '⌘' : 'Ctrl'}</kbd> <kbd>K</kbd>
        </span>
      </button>

      <nav className="header-nav" aria-label="Primary">
        <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
          Home
        </NavLink>
        <NavLink to="/roadmap" className={({ isActive }) => (isActive ? 'active' : '')}>
          Roadmap
        </NavLink>
        <NavLink to="/practice" className={({ isActive }) => (isActive ? 'active' : '')}>
          Practice
        </NavLink>
        <NavLink to="/revise" className={({ isActive }) => (isActive ? 'active' : '')}>
          Revise
        </NavLink>
        <NavLink to="/progress" className={({ isActive }) => (isActive ? 'active' : '')}>
          Progress
        </NavLink>
      </nav>

      <button
        className="btn btn-ghost btn-icon"
        onClick={toggleTheme}
        aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      >
        {theme === 'dark' ? <IconSun size={17} /> : <IconMoon size={17} />}
      </button>

      <div style={{ position: 'relative' }} ref={popRef}>
        <button
          className={`btn btn-ghost btn-icon${settings ? ' is-active' : ''}`}
          onClick={() => setSettings((s) => !s)}
          aria-label="Appearance settings"
          aria-expanded={settings}
        >
          <IconSettings size={17} />
        </button>
        {settings && (
          <div className="popover">
            <div className="popover-row">
              <div className="popover-label">Accent colour</div>
              <div className="swatches">
                {ACCENTS.map((a) => (
                  <button
                    key={a.id}
                    className={`swatch${accent === a.id ? ' active' : ''}`}
                    style={{ ['--sw' as string]: a.swatch }}
                    onClick={() => setAccent(a.id)}
                    title={a.label}
                    aria-label={a.label}
                    type="button"
                  />
                ))}
              </div>
            </div>
            <div className="popover-row">
              <div className="popover-label">Text density</div>
              <div className="seg">
                <button className={font === 'comfortable' ? 'active' : ''} onClick={() => setFont('comfortable')} type="button">
                  Comfortable
                </button>
                <button className={font === 'compact' ? 'active' : ''} onClick={() => setFont('compact')} type="button">
                  Compact
                </button>
              </div>
            </div>
            <div className="popover-row">
              <div className="popover-label">Theme</div>
              <div className="seg">
                <button className={theme === 'light' ? 'active' : ''} onClick={() => theme !== 'light' && toggleTheme()} type="button">
                  Light
                </button>
                <button className={theme === 'dark' ? 'active' : ''} onClick={() => theme !== 'dark' && toggleTheme()} type="button">
                  Dark
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
