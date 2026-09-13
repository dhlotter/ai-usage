import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isEnabled as isAutostartEnabled, enable as enableAutostart, disable as disableAutostart } from '@tauri-apps/plugin-autostart';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  ALERT_OPTIONS, ApiKeyRow, AUTH_MESSAGES, PROVIDERS, PROVIDER_SETUP, PROVIDER_META,
  ProvidersResponse, REFRESH_OPTIONS, Select, Settings as SettingsShape, Toggle,
  loadSettings, saveSettings, useSettingsSync,
} from './shared';
// App.css owns the palette and the shared controls (toggle, select, key row);
// Settings.css only adds this window's layout.
import './App.css';
import './Settings.css';

type Section = 'general' | 'providers';

export default function SettingsWindow() {
  const [section, setSection] = useState<Section>('general');
  const [settings, setSettings] = useState<SettingsShape>(loadSettings);
  const [data, setData] = useState<ProvidersResponse | null>(null);

  useSettingsSync(setSettings);

  // Applied immediately: a persistent window has no natural "Done" moment.
  const update = useCallback((patch: Partial<SettingsShape>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    try { setData(await invoke<ProvidersResponse>('get_providers', { enabled: [] })); }
    catch (e) { console.error(e); }
  }, []);

  // Kept live while open: fetched only on mount, a transient error caught at
  // that moment would sit here looking permanent.
  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, settings.refreshSecs * 1000);
    return () => clearInterval(iv);
  }, [refresh, settings.refreshSecs]);

  return (
    <div className="settings-window">
      <nav className="settings-nav">
        <button className={`nav-item ${section === 'general' ? 'active' : ''}`} onClick={() => setSection('general')}>
          <IconSliders /> General
        </button>
        <button className={`nav-item ${section === 'providers' ? 'active' : ''}`} onClick={() => setSection('providers')}>
          <IconStack /> Providers
        </button>
      </nav>

      <main className="settings-pane">
        {section === 'general'
          ? <General settings={settings} update={update} />
          : <Providers settings={settings} update={update} data={data} refresh={refresh} />}
      </main>
    </div>
  );
}

function General({ settings, update }: { settings: SettingsShape; update: (p: Partial<SettingsShape>) => void }) {
  const [autostart, setAutostart] = useState(false);

  useEffect(() => { isAutostartEnabled().then(setAutostart).catch(() => {}); }, []);

  const toggleAutostart = async (v: boolean) => {
    try {
      if (v) await enableAutostart(); else await disableAutostart();
      setAutostart(v);
    } catch (e) { console.error(e); }
  };

  const enabledProviders = PROVIDERS.filter(p => settings.enabled[p.id]);

  return (
    <>
      <h2 className="pane-title">General</h2>

      <section className="group">
        <div className="group-label">Startup</div>
        <div className="row">
          <span className="row-label">Start at login</span>
          <Toggle value={autostart} onChange={toggleAutostart} />
        </div>
      </section>

      <section className="group">
        <div className="group-label">Display</div>
        <div className="row">
          <div className="row-text">
            <span className="row-label">Show limits as</span>
            <span className="row-hint">Bars fill up as you spend, or drain as you run out.</span>
          </div>
          <Select
            value={settings.showRemaining ? 'remaining' : 'used'}
            onChange={v => update({ showRemaining: v === 'remaining' })}
          >
            <option value="used">Used</option>
            <option value="remaining">Remaining</option>
          </Select>
        </div>
      </section>

      <section className="group">
        <div className="group-label">Menu bar</div>
        <div className="row">
          <div className="row-text">
            <span className="row-label">Show countdown for</span>
            <span className="row-hint">The icon always shows every provider on hover.</span>
          </div>
          <Select
            value={settings.trayProvider ?? ''}
            onChange={v => update({ trayProvider: v || null })}
          >
            <option value="">Icon only</option>
            {enabledProviders.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </div>
      </section>

      <section className="group">
        <div className="group-label">Notifications</div>
        <div className="row">
          <span className="row-label">Alert when a limit runs low</span>
          <Toggle value={settings.notificationsEnabled} onChange={v => update({ notificationsEnabled: v })} />
        </div>
        <div className="row">
          <span className="row-label">Alert at</span>
          <Select
            value={String(settings.alertPct)}
            onChange={v => update({ alertPct: parseInt(v) })}
            disabled={!settings.notificationsEnabled}
          >
            {ALERT_OPTIONS.map(p => (
              <option key={p} value={p}>
                {settings.showRemaining ? `${100 - p}% left` : `${p}% used`}
              </option>
            ))}
          </Select>
        </div>
      </section>

      <section className="group">
        <div className="group-label">Refresh</div>
        <div className="row">
          <span className="row-label">Check every</span>
          <Select value={String(settings.refreshSecs)} onChange={v => update({ refreshSecs: parseInt(v) })}>
            {REFRESH_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </div>
      </section>

      <button className="quit-btn" onClick={() => invoke('quit_app').catch(() => {})}>Quit AI Usage</button>
    </>
  );
}

function Providers({ settings, update, data, refresh }: {
  settings: SettingsShape;
  update: (p: Partial<SettingsShape>) => void;
  data: ProvidersResponse | null;
  refresh: () => void;
}) {
  const byId = new Map((data?.providers ?? []).map(p => [p.id as string, p]));

  return (
    <>
      <h2 className="pane-title">Providers</h2>
      <p className="pane-intro">
        Each provider is read a different way, depending on what its vendor allows.
      </p>

      {PROVIDERS.map(({ id, name }) => {
        const p = byId.get(id);
        const on = settings.enabled[id] ?? false;
        const connected = p?.auth_state === 'ok';
        const setup = PROVIDER_SETUP[id];

        return (
          <section className="group provider-group" key={id}>
            <div className="row">
              <span className="row-icon" style={{ background: PROVIDER_META[id].tint }}>{PROVIDER_META[id].icon}</span>
              <div className="row-text">
                <span className="row-label">{name}</span>
                <span className={`row-state ${connected ? 'ok' : ''}`}>
                  {!p ? 'Checking…' : connected
                    ? `Connected${p.plan_type ? ` · ${p.plan_type}` : ''}`
                    : (AUTH_MESSAGES[p.auth_state] ?? p.auth_state)}
                </span>
              </div>
              <Toggle
                value={on}
                onChange={v => update({ enabled: { ...settings.enabled, [id]: v } })}
              />
            </div>

            {on && (
              <div className="provider-setup">
                <p className="provider-help">{setup.how}</p>

                {/* The sign-in command only matters while it is not connected. */}
                {setup.command && !connected && <CommandChip command={setup.command} />}

                {p?.accepts_key && <ApiKeyRow provider={id} onSaved={refresh} />}

                <div className="link-row">
                  {setup.links.map(l => <ExternalLink key={l.url} {...l} />)}
                </div>
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}

function IconSliders() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
    </svg>
  );
}

function IconStack() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2 2 7l10 5 10-5-10-5Z" /><path d="m2 17 10 5 10-5" /><path d="m2 12 10 5 10-5" />
    </svg>
  );
}

/** Opens in the real browser, not inside the app's webview. */
function ExternalLink({ label, url }: { label: string; url: string }) {
  return (
    <button className="ext-link" onClick={() => openUrl(url).catch(() => {})} title={url}>
      {label}
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M7 17 17 7M9 7h8v8" />
      </svg>
    </button>
  );
}

function CommandChip({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* clipboard unavailable, the command is still readable */ }
  };

  return (
    <div className="cmd-chip">
      <span className="cmd-hint">Run once to sign in</span>
      <code className="cmd">{command}</code>
      <button className="cmd-copy" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}
