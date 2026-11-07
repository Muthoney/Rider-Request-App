import { api } from '../api.js';
import { html, ic, busy } from '../ui.js';

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

export function renderLogin(app, { onSignedIn }) {
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
          <label for="password">Password</label>
          <div class="input-icon" style="position:relative">${ic('lock', 'sm')}
            <input class="input" id="password" name="password" type="password" autocomplete="current-password" required placeholder="••••••••••••">
            <button type="button" class="icon-btn" id="peek" aria-label="Show password" style="position:absolute;right:4px;top:3px">${ic('eye', 'sm')}</button>
          </div>
        </div>
        <button class="btn primary lg block" type="submit" data-busy=" Signing in…">Sign in ${ic('chevronRight', 'sm')}</button>
        <p class="muted" style="font-size:13px;text-align:center">Forgot your password? Ask an administrator to issue a temporary one from <b>Manage accounts</b>.</p>
      </form>
    </section>
  </div>`);
  const form = app.querySelector('form');
  const err = app.querySelector('#err');
  const pw = app.querySelector('#password');
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
