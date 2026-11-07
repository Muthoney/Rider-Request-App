import { html, ic, avatar, roleBadge, tagBadges, toast } from '../ui.js';
import { passwordFields, wirePasswordForm } from './password.js';
import { setTheme } from '../hosted.js';
import { getConfig } from '../config.js';

function integrations(c) {
  return [
    ['message', 'WhatsApp job notifications', c.notifications.whatsapp, 'Riders get a WhatsApp message when assigned.', 'Set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID.'],
    ['phone', "SMS fallback (Africa's Talking)", c.notifications.sms, 'Sent when WhatsApp fails or is not set up.', 'Set AT_USERNAME and AT_API_KEY.'],
    ['gps', 'Google Maps & live rider positions', !!c.maps.browserKey, 'Live map and request maps use Google Maps (Kenya).', 'Riders still share GPS; maps are drawn as illustrations until GOOGLE_MAPS_BROWSER_KEY is set.'],
    ['search', 'Kenya address search', c.geocoder === 'google', 'Google geocoding, limited to Kenya.', 'Using the built-in list of Kenyan landmarks, streets and areas.'],
    ['route', 'Road distances for quotes', c.routing === 'google', 'Google Routes API.', 'Straight-line distance × road factor.'],
    ['shield', 'Microsoft SSO', false, '', 'Sign-in uses email and password.'],
    ['gpsOff', 'GPS-verified handovers', false, '', 'Collections and handovers are recorded without a location check.'],
    ['doc', 'Email password recovery', false, '', 'Administrators issue temporary passwords instead.'],
  ];
}

export async function render(el, ctx) {
  const u = ctx.user;
  let theme = 'system';
  try { theme = localStorage.getItem('rr-theme') || 'system'; } catch {}
  const cfg = await getConfig();
  el.innerHTML = String(html`
    <div class="page-head"><div><h1>Settings</h1><p>Your profile, appearance and security.</p></div></div>
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
        <section class="card">
          <div class="card-head"><h2>Appearance</h2></div>
          <div class="card-body">
            <div class="seg" role="radiogroup" aria-label="Theme">
              ${[['system', 'System', 'settings'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']].map(([k, l, i]) => html`
                <label><input type="radio" name="theme" value="${k}" ${theme === k ? 'checked' : ''}>${ic(i, 'sm')}${l}</label>`)}
            </div>
          </div>
        </section>
        <section class="card">
          <div class="card-head"><div><h2>Integrations</h2><p>Configured by the server administrator</p></div></div>
          <div class="list">${integrations(cfg).map(([i, t, on, yes, no]) => html`
            <div class="list-item"><span class="avatar" style="background:${on ? 'var(--brand-50)' : 'var(--surface-3)'};color:${on ? 'var(--brand)' : 'var(--muted)'}">${ic(i, 'sm')}</span>
              <div class="grow"><b>${t}</b><div class="req-sub">${on ? yes : no}</div></div><span class="badge ${on ? 's-delivered' : 'b-outline'}">${on ? 'Connected' : 'Not connected'}</span></div>`)}</div>
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
    </div>`);
  el.querySelectorAll('[name=theme]').forEach((r) => r.addEventListener('change', () => { setTheme(r.value); toast('Theme updated'); }));
  const form = el.querySelector('#pw');
  wirePasswordForm(form, {
    user: u, errEl: el.querySelector('#pwerr'),
    onSuccess: () => { form.reset(); form.next.dispatchEvent(new Event('input')); toast('Password updated. Other sessions were signed out.'); },
  });
}
