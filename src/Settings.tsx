import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isEnabled as isAutostartEnabled, enable as enableAutostart, disable as disableAutostart } from '@tauri-apps/plugin-autostart';
import {
  ALERT_OPTIONS, ApiKeyRow, AUTH_MESSAGES, PROVIDERS, PROVIDER_AUTH, PROVIDER_META,
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
          General
        </button>
        <button className={`nav-item ${section === 'providers' ? 'active' : ''}`} onClick={() => setSection('providers')}>
          Providers
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
            {ALERT_OPTIONS.map(p => <option key={p} value={p}>{p}% used</option>)}
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
              <>
                <div className="provider-help">{PROVIDER_AUTH[id]}</div>
                {p?.accepts_key && <ApiKeyRow provider={id} onSaved={refresh} />}
              </>
            )}
          </section>
        );
      })}
    </>
  );
}
