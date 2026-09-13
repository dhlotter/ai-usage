import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';

// ── Types ────────────────────────────────────────────────────────────

export interface UsageWindow {
  label: string;
  used_percent: number;
  /** 0 when the provider reports no reset time, which reads as "ready". */
  resets_at_unix: number;
}

export interface ProviderUsage {
  id: 'claude' | 'codex' | 'glm' | 'antigravity';
  display_name: string;
  short_label: string;
  windows: UsageWindow[];
  plan_type: string | null;
  auth_state: 'ok' | 'no_credentials' | 'auth_failed' | 'network_error' | 'not_running' | 'not_implemented' | 'rate_limited';
  auth_error: string | null;
  accepts_key: boolean;
}

export interface ProvidersResponse {
  providers: ProviderUsage[];
  last_updated: string;
  now_unix: number;
}

export interface Settings {
  enabled: Record<string, boolean>;
  notificationsEnabled: boolean;
  alertPct: number;
  refreshSecs: number;
  /** which provider's countdown to display in the menubar, or null for icon-only */
  trayProvider: string | null;
  /** Show what is left rather than what has been spent. */
  showRemaining: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: { claude: true, codex: true, glm: true, antigravity: true },
  notificationsEnabled: true,
  alertPct: 80,
  refreshSecs: 60,
  trayProvider: null,
  showRemaining: false,
};

export const ALERT_OPTIONS = [50, 75, 80, 90, 95];

export const REFRESH_OPTIONS = [
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
];

export const PROVIDERS: { id: string; name: string }[] = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
  { id: 'glm', name: 'GLM' },
  { id: 'antigravity', name: 'Antigravity' },
];

/** `rgb` is the same colour as `tint`, as channels, for tinting a card wash. */
export const PROVIDER_META: Record<string, { icon: string; tint: string; rgb: string }> = {
  claude: { icon: 'C', tint: '#d97706', rgb: '217, 119, 6' },
  codex:  { icon: '○', tint: '#10a37f', rgb: '16, 163, 127' },
  glm:    { icon: 'G', tint: '#4361ee', rgb: '67, 97, 238' },
  antigravity: { icon: 'A', tint: '#8b5cf6', rgb: '139, 92, 246' },
};

/** Wash hues for states that should not carry a brand colour. */
export const DANGER_RGB = '255, 69, 58';
export const NEUTRAL_RGB = '255, 255, 255';

export interface ProviderSetup {
  /** Where the reading comes from, in one line. */
  how: string;
  /** Run this once to sign in, shown with a copy button when disconnected. */
  command?: string;
  /** Everything needed to finish setup, so nothing has to be guessed at. */
  links: { label: string; url: string }[];
}

/** All URLs checked to resolve; keep it that way when editing. */
export const PROVIDER_SETUP: Record<string, ProviderSetup> = {
  claude: {
    how: 'Reads the credential Claude Code stores in your keychain when you sign in.',
    command: 'claude',
    links: [{ label: 'Install Claude Code', url: 'https://docs.claude.com/en/docs/claude-code/overview' }],
  },
  codex: {
    how: 'Reads ~/.codex/auth.json, written when you sign in to the Codex CLI.',
    command: 'codex',
    links: [{ label: 'Install Codex CLI', url: 'https://developers.openai.com/codex/cli/' }],
  },
  antigravity: {
    how: 'Read from the running Antigravity IDE. Its quota is only available while the IDE is open, so the card goes quiet when it is closed.',
    links: [{ label: 'About Antigravity', url: 'https://antigravity.google/' }],
  },
  glm: {
    how: 'Needs a Z.ai API key. The key from your coding plan reports its own quota.',
    links: [
      { label: 'Get an API key', url: 'https://z.ai/manage-apikey/apikey-list' },
      { label: 'Coding plan docs', url: 'https://docs.z.ai/devpack/overview' },
    ],
  },
};

// ── Settings storage ─────────────────────────────────────────────────

const STORAGE_KEY = 'ai-usage-settings';
const CHANGED_EVENT = 'settings-changed';

export function loadSettings(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...DEFAULT_SETTINGS, ...stored, enabled: { ...DEFAULT_SETTINGS.enabled, ...(stored.enabled || {}) } };
  } catch { return DEFAULT_SETTINGS; }
}

/** Persist and tell the other window, which holds its own copy in React state. */
export function saveSettings(s: Settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  emit(CHANGED_EVENT).catch(() => {});
}

/** Re-read settings whenever the other window saves. */
export function useSettingsSync(onChange: (s: Settings) => void) {
  useEffect(() => {
    const un = listen(CHANGED_EVENT, () => onChange(loadSettings()));
    return () => { un.then(f => f()).catch(() => {}); };
  }, [onChange]);
}

// ── Formatting ───────────────────────────────────────────────────────

export function fmtCountdown(secsRemaining: number): string {
  if (secsRemaining <= 0) return 'Ready';
  const h = Math.floor(secsRemaining / 3600);
  const m = Math.floor((secsRemaining % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

/// The window closest to its limit, which is the one that will actually stop you
/// working. Headline number, tray tooltip and alerts all read from here.
///
/// Showing the 5-hour figure alone used to hide the window that matters: a
/// weekly limit at 100% with three days left on the clock rendered as "0%"
/// beside a full red bar, and never raised an alert. A 5-hour window resets
/// while you make coffee; a weekly one ends your week.
export function worstWindow(p: ProviderUsage): UsageWindow | null {
  return (p.windows ?? []).reduce<UsageWindow | null>(
    (worst, w) => (worst === null || w.used_percent > worst.used_percent ? w : worst),
    null,
  );
}

/** Percentages are always stored as used; this is the only place that flips. */
export function displayPct(usedPercent: number, showRemaining: boolean): number {
  return showRemaining ? 100 - usedPercent : usedPercent;
}

/**
 * Colour always comes from the used figure, never the displayed one. Reading it
 * off "8% remaining" would paint a nearly spent limit green.
 */
export function barColor(pct: number): string {
  if (pct >= 90) return 'var(--red)';
  if (pct >= 75) return 'var(--yellow)';
  return 'var(--green)';
}

/** Neutral under 50%, then yellow → orange → red as it approaches 100%. */
export function pctTextColor(pct: number): string {
  if (pct < 50) return 'rgba(255, 255, 255, 0.92)';
  const t = Math.min(1, (pct - 50) / 50);
  const hue = 50 - 50 * t; // 50° (yellow) → 0° (red)
  return `hsl(${hue}, 90%, 62%)`;
}

export const AUTH_MESSAGES: Record<string, string> = {
  no_credentials: 'Not signed in',
  auth_failed: 'Token expired',
  network_error: 'Connection error',
  not_running: 'Not running',
  not_implemented: 'Coming soon',
  rate_limited: 'Rate limited',
};

// ── Controls ─────────────────────────────────────────────────────────

export function Toggle({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      className={`toggle ${value ? 'on' : ''} ${disabled ? 'disabled' : ''}`}
      onClick={() => !disabled && onChange(!value)}
      aria-pressed={value}
    >
      <span className="toggle-knob" />
    </button>
  );
}

export function Select({ value, onChange, children, disabled }: { value: string; onChange: (v: string) => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <select
      className={`native-select ${disabled ? 'disabled' : ''}`}
      value={value}
      disabled={disabled}
      onChange={e => onChange(e.target.value)}
    >
      {children}
    </select>
  );
}

/**
 * Write-only: a stored key is never read back into the frontend, the backend
 * only reports whether one exists.
 */
export function ApiKeyRow({ provider, onSaved }: { provider: string; onSaved: () => void }) {
  const [stored, setStored] = useState<boolean | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<boolean>('has_provider_key', { provider }).then(setStored).catch(() => setStored(false));
  }, [provider]);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      await invoke('set_provider_key', { provider, key: value });
      setValue(''); setStored(true); onSaved();
    } catch (e) { setError(String(e)); }
    setBusy(false);
  };

  const remove = async () => {
    setBusy(true); setError(null);
    try {
      await invoke('clear_provider_key', { provider });
      setStored(false); onSaved();
    } catch (e) { setError(String(e)); }
    setBusy(false);
  };

  if (stored === null) return null;

  return (
    <div className="key-row">
      {stored ? (
        <>
          <span className="key-status">API key saved</span>
          <button className="key-btn" onClick={remove} disabled={busy}>Remove</button>
        </>
      ) : (
        <>
          <input
            className="key-input"
            type="password"
            placeholder="Paste API key"
            value={value}
            spellCheck={false}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && value.trim() && !busy) save(); }}
          />
          <button className="key-btn" onClick={save} disabled={busy || !value.trim()}>Save</button>
        </>
      )}
      {error && <div className="key-error">{error}</div>}
    </div>
  );
}
