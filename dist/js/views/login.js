import { api } from '../api.js';
import { html, ic, busy } from '../ui.js';
import { passwordFields, strength } from './password.js';

export function authArt() {
  return html`
  <section class="auth-art" aria-hidden="false">
    <svg class="routes" viewBox="0 0 600 800" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <path class="route-path" d="M60 700 C 160 560, 120 420, 260 380 S 420 220, 540 120"/>
      <path class="route-path" d="M20 300 C 140 320, 220 460, 360 470 S 520 600, 590 720"/>
      <path class="route-path" d="M300 790 C 320 640, 440 560, 480 420 S 420 200, 330 40"/>
      ${[[260, 380], [540, 120], [360, 470], [480, 420], [60, 700]].map(([x, y]) => html`
        <circle class="node-ring" cx="${x}" cy="${y}" r="10"/><circle class="node" cx="${x}" cy="${y}" r="6"/>`)}
    </svg>
    <a class="brand" href="#/" style="position:relative;padding:0">
      <span class="brand-mark">${ic('bike')}</span><span><b>Rider Requests</b><small>Internal delivery coordination</small></span>
    </a>
    <div class="copy">
      <h1>Every pickup, rider and handover in one place.</h1>
      <p>Requesters book deliveries, dispatchers assign the right rider, and riders record each collection and handover as it happens.</p>
      <div class="feats">
        <div><span class="ic">${ic('board')}</span>Drag-and-drop dispatch with priority rules</div>
        <div><span class="ic">${ic('message')}</span>Import WhatsApp messages and map pins</div>
        <div><span class="ic">${ic('shield')}</span>Company-isolated, audited and version-checked</div>
      </div>
    </div>
    <small style="position:relative;color:rgba(255,255,255,.5)">Sanitized example deployment · No live accounts</small>
  </section>`;
}

export function renderLogin(app, { onSignedIn, onForgot }) {
  app.innerHTML = String(html`
  <div class="auth">
    ${authArt()}
    <section class="auth-form">
      <form class="auth-card" novalidate>
        <div class="head">
          <h1>Sign in</h1>
          <p>Use the email and password your administrator gave you.</p>
        </div>
        <div class="alert err" id="err" hidden role="alert"></div>
        <div class="field">
          <label for="email">Work email</label>
          <div class="input-icon">${ic('user', 'sm')}<input class="input" id="email" name="email" type="email" autocomplete="username" required placeholder="you@company.com" autofocus></div>
        </div>
        <div class="field">
          <div class="row between"><label for="password">Password</label><a href="#/forgot" class="link-sm" id="forgot">Forgot password?</a></div>
          <div class="input-icon" style="position:relative">${ic('lock', 'sm')}
            <input class="input" id="password" name="password" type="password" autocomplete="current-password" required placeholder="••••••••••••">
            <button type="button" class="icon-btn" id="peek" aria-label="Show password" style="position:absolute;right:4px;top:3px">${ic('eye', 'sm')}</button>
          </div>
        </div>
        <button class="btn primary lg block" type="submit" data-busy=" Signing in…">Sign in ${ic('chevronRight', 'sm')}</button>
        <p class="muted" style="font-size:13px;text-align:center">Can't get a reset link? An administrator can issue a temporary password from <b>Manage accounts</b>.</p>
      </form>
    </section>
  </div>`);
  const form = app.querySelector('form');
  const err = app.querySelector('#err');
  const pw = app.querySelector('#password');
  app.querySelector('#forgot').addEventListener('click', (e) => { e.preventDefault(); onForgot?.(); });
  app.querySelector('#peek').addEventListener('click', (e) => {
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    e.currentTarget.innerHTML = String(ic(show ? 'eyeOff' : 'eye', 'sm'));
    e.currentTarget.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = form.email.value.trim();
    const password = form.password.value;
    err.hidden = true;
    form.email.removeAttribute('aria-invalid'); pw.removeAttribute('aria-invalid');
    if (!email || !password) {
      err.textContent = 'Enter your email and password.'; err.hidden = false;
      (!email ? form.email : pw).setAttribute('aria-invalid', 'true');
      return;
    }
    busy(form.querySelector('[type=submit]'), async () => {
      try {
        const res = await api.post('/api/auth/login', { email, password });
        onSignedIn(res.user, res.csrf);
      } catch (ex) {
        err.textContent = ex.message; err.hidden = false;
        pw.setAttribute('aria-invalid', 'true'); pw.select();
      }
    });
  });
}

/** Step 1 of recovery: ask for the email. The reply never reveals whether the account exists. */
export function renderForgot(app, { onBack }) {
  app.innerHTML = String(html`
  <div class="auth">
    ${authArt()}
    <section class="auth-form">
      <form class="auth-card" novalidate>
        <div class="head">
          <span class="badge s-assigned" style="margin-bottom:12px">${ic('key')} Password recovery</span>
          <h1>Forgot your password?</h1>
          <p>Enter your work email. We'll email you a link to set a new password. If email can't reach you, the link goes to the mobile number on your account by WhatsApp or SMS.</p>
        </div>
        <div class="alert err" id="err" hidden role="alert"></div>
        <div class="alert ok" id="ok" hidden role="status"></div>
        <div class="field">
          <label for="email">Work email</label>
          <div class="input-icon">${ic('mail', 'sm')}<input class="input" id="email" name="email" type="email" autocomplete="username" required placeholder="you@company.com" autofocus></div>
        </div>
        <button class="btn primary lg block" type="submit" data-busy=" Sending…">${ic('send', 'sm')} Send reset link</button>
        <button class="btn ghost block" type="button" id="back">${ic('chevronLeft', 'sm')} Back to sign in</button>
        <div class="recovery-chans" aria-hidden="true">
          <span>${ic('mail', 'sm')} Email</span>${ic('chevronRight', 'sm')}<span>${ic('whatsapp', 'sm')} WhatsApp</span>${ic('chevronRight', 'sm')}<span>${ic('phone', 'sm')} SMS</span>
        </div>
      </form>
    </section>
  </div>`);
  const form = app.querySelector('form');
  const err = app.querySelector('#err');
  const ok = app.querySelector('#ok');
  app.querySelector('#back').addEventListener('click', onBack);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    err.hidden = true; ok.hidden = true;
    const email = form.email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = 'Enter the email address you sign in with.'; err.hidden = false; form.email.setAttribute('aria-invalid', 'true'); return; }
    form.email.removeAttribute('aria-invalid');
    busy(form.querySelector('[type=submit]'), async () => {
      try {
        const res = await api.post('/api/auth/forgot', { email });
        ok.innerHTML = String(html`${ic('checkCircle', 'sm')}<span>${res.message} The link works once and expires in 30 minutes.</span>`);
        ok.hidden = false;
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    });
  });
}

/** Step 2 of recovery: choose a new password using the link's token. */
export function renderReset(app, { token, onDone, onForgot }) {
  app.innerHTML = String(html`
  <div class="auth">
    ${authArt()}
    <section class="auth-form">
      <form class="auth-card" novalidate>
        <div class="head">
          <span class="badge s-assigned" style="margin-bottom:12px">${ic('key')} Password recovery</span>
          <h1>Choose a new password</h1>
          <p>Use at least 12 characters. You'll be signed out of every other device.</p>
        </div>
        <div class="alert err" id="err" hidden role="alert"></div>
        ${token ? html`${passwordFields('r-')}
        <button class="btn primary lg block" type="submit" data-busy=" Saving…">${ic('lock', 'sm')} Save new password</button>`
    : html`<div class="alert warn">${ic('alert', 'sm')}<span>This link is incomplete. Open the full link from your message, or ask for a new one.</span></div>`}
        <button class="btn ghost block" type="button" id="again">${ic('refresh', 'sm')} Send me a new link</button>
      </form>
    </section>
  </div>`);
  const form = app.querySelector('form');
  const err = app.querySelector('#err');
  app.querySelector('#again').addEventListener('click', onForgot);
  // The recovery form has no "current password"; reuse the strength meter for the new one.
  form.querySelector('#r-current')?.closest('.field')?.remove();
  if (!token) return;
  const meter = form.querySelector('.pw-meter i');
  const list = form.querySelector('.checklist');
  const colors = ['#dc2626', '#f97316', '#eab308', '#22c55e', '#16a34a', '#15803d'];
  const update = () => {
    const { checks, score } = strength(form.next.value);
    meter.style.width = `${(score / 5) * 100}%`;
    meter.style.background = colors[score];
    list.innerHTML = String(html`${checks.filter((c) => !/email/.test(c.label)).map((c) => html`<div class="${c.ok ? 'ok' : ''}">${ic(c.ok ? 'checkCircle' : 'clock')}${c.label}</div>`)}`);
  };
  form.next.addEventListener('input', update);
  update();
  form.next.focus();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    err.hidden = true;
    if (form.next.value.length < 12) { err.textContent = 'Use at least 12 characters.'; err.hidden = false; return; }
    if (form.next.value !== form.confirm.value) { err.textContent = 'The new passwords do not match.'; err.hidden = false; form.confirm.focus(); return; }
    busy(form.querySelector('[type=submit]'), async () => {
      try {
        await api.post('/api/auth/reset', { token, password: form.next.value });
        app.querySelector('.auth-card').innerHTML = String(html`
          <div class="head"><span class="badge s-delivered" style="margin-bottom:12px">${ic('checkCircle')} Done</span>
            <h1>Password updated</h1><p>Sign in with your new password.</p></div>
          <button class="btn primary lg block" type="button" id="signin">Sign in ${ic('chevronRight', 'sm')}</button>`);
        app.querySelector('#signin').addEventListener('click', onDone);
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    });
  });
}
