import { html, ic, avatar, roleBadge, tagBadges, toast } from '../ui.js';
import { passwordFields, wirePasswordForm } from './password.js';
import { setTheme } from '../hosted.js';
import { getConfig } from '../config.js';
import { busy } from '../ui.js';
import { api } from '../api.js';

/**
 * Every integration with its state: 'on' (connected), 'setup' (built, waiting for keys or an account)
 * or 'planned' (not built yet). `todo` says what is needed; `fallback` what happens meanwhile.
 */
function integrations(c) {
  const item = (icon, title, on, what, todo, fallback) => ({ icon, title, state: on ? 'on' : 'setup', what, todo, fallback });
  const planned = (icon, title, what, fallback) => ({ icon, title, state: 'planned', what, fallback });
  return [
    item('whatsapp', 'WhatsApp job notifications', c.notifications.whatsapp, 'Riders get a WhatsApp message when assigned; first fallback for password recovery.',
      'Set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID, approve the job template, and set the webhook.', 'Notifications are recorded as not sent.'),
    item('phone', "SMS fallback (Africa's Talking)", c.notifications.sms, 'Critical updates (assignments, address changes, emergencies, cancellations) reach people by SMS when the app cannot; queued, retried and de-duplicated.',
      'Set AT_USERNAME, AT_API_KEY and AT_SENDER_ID; for delivery reports set AT_CALLBACK_TOKEN and the callback URL /api/webhooks/sms?token=….', 'Notifications are in-app only.'),
    item('bell', 'Android push notifications (Firebase)', c.notifications.push, 'Alerts reach the Android app even when it is closed.',
      'Create a Firebase project, add google-services.json to the Android build and set FCM_SERVICE_ACCOUNT on the server.', 'The app alerts while open; SMS covers the rest.'),
    item('mail', 'Email password recovery', !!c.email, 'Reset links are emailed; WhatsApp, then SMS, if email fails.',
      'Set SMTP_HOST and SMTP_FROM (plus SMTP_USER / SMTP_PASS).', 'Reset links go by WhatsApp or SMS if those are set up; administrators can issue temporary passwords.'),
    item('gps', 'Google Maps & live rider positions', !!c.maps.browserKey, 'Live map and request maps use Google Maps (Kenya).',
      'Set GOOGLE_MAPS_BROWSER_KEY (restricted to this site).', 'Riders still share GPS; maps are drawn as illustrations.'),
    item('search', 'Kenya address search', c.geocoder === 'google', 'Google geocoding, limited to Kenya.',
      'Set GOOGLE_MAPS_SERVER_KEY with the Geocoding API enabled.', 'The built-in list of Kenyan landmarks, streets and areas is used.'),
    item('route', 'Road distances for quotes', c.routing === 'google', 'Google Routes API road distance and time.',
      'Set GOOGLE_MAPS_SERVER_KEY with the Routes API enabled.', 'Straight-line distance × road factor.'),
    planned('message', 'WhatsApp request intake', 'Requests arrive automatically from a WhatsApp number.', 'Requesters paste messages into Import from WhatsApp.'),
    planned('key', 'WhatsApp OTP sign-in', 'Sign in with a one-time code sent by WhatsApp.', 'Email and password sign-in.'),
    planned('shield', 'Microsoft SSO (Entra ID)', 'Sign in with company Microsoft accounts.', 'Email and password sign-in.'),
    { icon: 'gps', title: 'GPS on collections and handovers', state: 'on', what: 'Each proof record stores the phone’s position and is checked against the stop’s pin.' },
    { icon: 'bike', title: 'Android app with background GPS', state: 'on', what: 'The Android app keeps sharing location with the screen off, and works offline.' },
    { icon: 'cloud', title: 'Offline mode and sync', state: 'on', what: 'Jobs, proofs, incidents and GPS are kept on the phone without signal and synced without duplicates.' },
    planned('route', 'Route optimisation', 'Best order for multi-pickup, multi-drop trips.', 'Stops are visited in the order entered.'),
    planned('download', 'Off-server backups', 'Copy nightly backups to another location and rehearse a restore.', 'Backups are kept on the server only.'),
  ];
}

const STATE = {
  on: { label: 'Connected', badge: 's-delivered', tone: 'on' },
  setup: { label: 'Needs setup', badge: 's-pending', tone: 'setup' },
  planned: { label: 'Not built yet', badge: 'b-outline', tone: 'planned' },
};

function integrationsCard(cfg, isAdmin) {
  const all = integrations(cfg);
  const group = (state, title, sub) => {
    const list = all.filter((x) => x.state === state);
    return html`<div class="int-col int-${state}">
      <div class="int-head"><span class="badge ${STATE[state].badge} dot">${title}</span><span class="muted">${list.length}</span></div>
      <p class="muted int-sub">${sub}</p>
      ${list.length ? html`<div class="stack-sm">${list.map((x) => html`
        <div class="int-item">
          <span class="int-ic">${ic(x.icon, 'sm')}</span>
          <div class="grow"><b>${x.title}</b><div class="req-sub">${x.what}</div>
            ${state !== 'on' ? html`<div class="int-note">${ic('clock', 'sm')}<span>Meanwhile: ${x.fallback}</span></div>` : ''}
            ${state === 'setup' && isAdmin ? html`<div class="int-note todo">${ic('settings', 'sm')}<span>To connect: ${x.todo}</span></div>` : ''}</div>
        </div>`)}</div>` : html`<p class="muted" style="font-size:13px">${state === 'on' ? 'Nothing connected yet.' : 'Nothing here.'}</p>`}
    </div>`;
  };
  const on = all.filter((x) => x.state === 'on').length;
  return html`<section class="card" style="margin-top:20px">
    <div class="card-head"><div><h2>Integrations</h2><p>${on} connected · ${all.length - on} still to work on. Keys are set on the server (see .env.example).</p></div></div>
    <div class="int-grid">
      ${group('on', 'Connected', 'Working now.')}
      ${group('setup', 'Needs setup', 'Built in the app; waiting for keys or an account.')}
      ${group('planned', 'Not built yet', 'On the roadmap.')}
    </div>
  </section>`;
}

export async function render(el, ctx) {
  const u = ctx.user;
  let theme = 'system';
  try { theme = localStorage.getItem('rr-theme') || 'system'; } catch {}
  const cfg = await getConfig();
  const staff = ['admin', 'manager', 'dispatcher'].includes(u.role);
  const [prefs, ops] = await Promise.all([api.get('/api/me/preferences').catch(() => null), staff ? api.get('/api/ops/settings').catch(() => null) : null]);
  const o = ops?.settings;
  const isAdmin = u.role === 'admin';
  const num = (name, label, value, min, max, step, unit, hint) => html`<div class="field"><label for="ops-${name}">${label}</label>
    <div class="input-suffix"><input class="input" id="ops-${name}" name="${name}" type="number" min="${min}" max="${max}" step="${step}" value="${value}" ${isAdmin ? '' : 'disabled'} inputmode="decimal"><span>${unit}</span></div>
    ${hint ? html`<span class="hint">${hint}</span>` : ''}</div>`;
  el.innerHTML = String(html`
    <div class="page-head"><div><h1>Settings</h1><p>Your profile, appearance, security and the app's integrations.</p></div></div>
    <div class="grid g-2" style="align-items:start">
      <div class="stack">
        <section class="card">
          <div class="card-head"><h2>Profile</h2></div>
          <div class="card-body stack">
            <div class="row">${avatar(u.name, 'lg')}<div><h3>${u.name}</h3><div class="muted">${u.email}</div></div></div>
            <dl class="kv">
              <dt>Role</dt><dd>${roleBadge(u.role)}</dd>
              ${u.tags.length ? html`<dt>Designations</dt><dd class="row" style="gap:6px">${tagBadges(u.tags)}</dd>` : ''}
              <dt>Company</dt><dd>${u.companyName}</dd>
              <dt>Phone</dt><dd>${u.phone || '—'}</dd>
            </dl>
            <p class="muted" style="font-size:13px">Ask an administrator to change your name, role or designations.</p>
          </div>
        </section>
        ${prefs ? html`<section class="card">
          <div class="card-head"><div><h2>Notifications</h2><p>Everything appears in the app. SMS is the backup when the app can't reach you.</p></div></div>
          <div class="card-body stack-sm">
            ${[['critical', 'Critical only (recommended)', 'Assignments, address changes, cancellations and emergencies, if you have not seen them in the app.'],
              ['all', 'All updates', 'Also pickup, drop-off and delivery updates, when the app is closed.'],
              ['off', 'No SMS', 'In-app only. Dispatchers still get emergency SMS.']].map(([k, l, d]) => html`
              <label class="choice"><input type="radio" name="smsPref" value="${k}" ${prefs.smsPref === k ? 'checked' : ''}><b>${l}</b><small>${d}</small></label>`)}
            ${prefs.hasPhone ? '' : html`<div class="alert warn">${ic('phone', 'sm')}<span>Your account has no mobile number, so SMS can't reach you. Ask an administrator to add it.</span></div>`}
          </div>
        </section>` : ''}
        <section class="card">
          <div class="card-head"><h2>Appearance</h2></div>
          <div class="card-body">
            <div class="seg" role="radiogroup" aria-label="Theme">
              ${[['system', 'System', 'settings'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']].map(([k, l, i]) => html`
                <label><input type="radio" name="theme" value="${k}" ${theme === k ? 'checked' : ''}>${ic(i, 'sm')}${l}</label>`)}
            </div>
          </div>
        </section>
      </div>
      <section class="card">
        <div class="card-head"><div><h2>Change password</h2><p>You'll stay signed in here; other sessions are signed out.</p></div></div>
        <form class="card-body stack" id="pw" novalidate>
          <div class="alert err" id="pwerr" hidden role="alert"></div>
          ${passwordFields('s-')}
          <div><button class="btn primary" type="submit" data-busy=" Saving…">${ic('lock', 'sm')} Update password</button></div>
        </form>
      </section>
    </div>
    ${o ? html`<section class="card" style="margin-top:20px">
      <div class="card-head"><div><h2>Operations</h2><p>${isAdmin ? 'Rider availability, shift length and notification rules for your company.' : 'Set by an administrator.'}</p></div></div>
      <form class="card-body" id="ops-form" novalidate>
        <div class="form-grid three">
          ${num('maxActiveJobs', 'Active jobs per rider', o.maxActiveJobs, 1, 10, 1, 'jobs', 'More needs an authorised override.')}
          ${num('standbyTimeoutMin', 'Standby timeout', o.standbyTimeoutMin, 5, 240, 1, 'min', 'Clocked-in riders not heard from in this time show as “not responding”.')}
          ${num('breakMaxMin', 'Longest break', o.breakMaxMin, 5, 240, 1, 'min', 'Dispatch is told when a break runs longer.')}
          ${num('shiftHours', 'Standard shift', o.shiftHours, 1, 16, 0.5, 'hours', 'Time past this is overtime.')}
          ${num('overtimeMaxHours', 'Most overtime per shift', o.overtimeMaxHours, 0.5, 8, 0.5, 'hours')}
          ${num('smsFallbackSeconds', 'SMS fallback after', o.smsFallbackSeconds, 30, 900, 10, 'sec', 'Unseen critical notifications are texted after this delay.')}
          <div class="field"><label for="ops-dp">Dispatch phone</label><input class="input" id="ops-dp" name="dispatchPhone" type="tel" value="${o.dispatchPhone || ''}" ${isAdmin ? '' : 'disabled'} placeholder="+254 7…"><span class="hint">Shown to riders and requesters on active deliveries.</span></div>
          <div class="field"><span class="label">Recipients</span><label class="switch"><input type="checkbox" name="smsRecipients" ${o.smsRecipients ? 'checked' : ''} ${isAdmin ? '' : 'disabled'}> Text recipients when their delivery is on the way</label></div>
        </div>
        ${isAdmin ? html`<div style="margin-top:12px"><button class="btn primary" type="submit" data-busy=" Saving…">${ic('check', 'sm')} Save operations settings</button></div>` : ''}
      </form>
    </section>` : ''}
    ${integrationsCard(cfg, u.role === 'admin')}`);
  el.querySelectorAll('[name=smsPref]').forEach((r) => r.addEventListener('change', async () => {
    try { await api.patch('/api/me/preferences', { smsPref: r.value }); toast('Notification preference saved'); } catch (err) { toast(err.message, 'err'); }
  }));
  el.querySelector('#ops-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const n = (k) => Number(f[k].value);
    busy(f.querySelector('[type=submit]'), async () => {
      try {
        await api.patch('/api/ops/settings', {
          maxActiveJobs: n('maxActiveJobs'), standbyTimeoutMin: n('standbyTimeoutMin'), breakMaxMin: n('breakMaxMin'), shiftHours: n('shiftHours'),
          overtimeMaxHours: n('overtimeMaxHours'), smsFallbackSeconds: n('smsFallbackSeconds'), dispatchPhone: f.dispatchPhone.value.trim() || null, smsRecipients: f.smsRecipients.checked,
        });
        toast('Operations settings saved');
      } catch (err) { toast(err.message, 'err'); }
    });
  });
  el.querySelectorAll('[name=theme]').forEach((r) => r.addEventListener('change', () => { setTheme(r.value); toast('Theme updated'); }));
  const form = el.querySelector('#pw');
  wirePasswordForm(form, {
    user: u, errEl: el.querySelector('#pwerr'),
    onSuccess: () => { form.reset(); form.next.dispatchEvent(new Event('input')); toast('Password updated. Other sessions were signed out.'); },
  });
}
