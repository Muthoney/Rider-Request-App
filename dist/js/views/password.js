import { api } from '../api.js';
import { html, ic, busy, firstName } from '../ui.js';
import { authArt } from './login.js';

export function strength(pw, email = '') {
  const checks = [
    { ok: pw.length >= 12, label: 'At least 12 characters' },
    { ok: /[a-z]/.test(pw) && /[A-Z]/.test(pw), label: 'Upper- and lower-case letters' },
    { ok: /\d|[^A-Za-z0-9]/.test(pw), label: 'A number or symbol' },
    { ok: !!pw && !(email && pw.toLowerCase().includes(email.split('@')[0].toLowerCase())), label: 'Does not contain your email name' },
  ];
  let score = checks.filter((c) => c.ok).length;
  if (pw.length >= 16) score += 1;
  return { checks, score: Math.min(score, 5) };
}

export function passwordFields(prefix = '') {
  return html`
    <div class="field">
      <label for="${prefix}current">Current ${prefix ? '' : 'temporary '}password</label>
      <input class="input" id="${prefix}current" name="current" type="password" autocomplete="current-password" required>
    </div>
    <div class="field">
      <label for="${prefix}next">New password</label>
      <input class="input" id="${prefix}next" name="next" type="password" autocomplete="new-password" required minlength="12">
      <div class="pw-meter" aria-hidden="true"><i></i></div>
      <div class="checklist" aria-live="polite"></div>
    </div>
    <div class="field">
      <label for="${prefix}confirm">Confirm new password</label>
      <input class="input" id="${prefix}confirm" name="confirm" type="password" autocomplete="new-password" required>
    </div>`;
}

export function wirePasswordForm(form, { user, onSuccess, errEl }) {
  const meter = form.querySelector('.pw-meter i');
  const list = form.querySelector('.checklist');
  const colors = ['#dc2626', '#f97316', '#eab308', '#22c55e', '#16a34a', '#15803d'];
  const update = () => {
    const { checks, score } = strength(form.next.value, user.email);
    meter.style.width = `${(score / 5) * 100}%`;
    meter.style.background = colors[score];
    list.innerHTML = String(html`${checks.map((c) => html`<div class="${c.ok ? 'ok' : ''}">${ic(c.ok ? 'checkCircle' : 'clock')}${c.label}</div>`)}`);
  };
  form.next.addEventListener('input', update);
  update();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    errEl.hidden = true;
    if (form.next.value.length < 12) { errEl.textContent = 'Use at least 12 characters.'; errEl.hidden = false; return; }
    if (form.next.value !== form.confirm.value) { errEl.textContent = 'The new passwords do not match.'; errEl.hidden = false; form.confirm.focus(); return; }
    busy(form.querySelector('[type=submit]'), async () => {
      try {
        const res = await api.post('/api/auth/password', { current: form.current.value, next: form.next.value });
        onSuccess(res.user);
      } catch (ex) {
        errEl.textContent = ex.message; errEl.hidden = false;
      }
    });
  });
}

export function renderPasswordChange(app, { user, onDone, onLogout }) {
  const exp = user.tempExpiresAt ? new Date(user.tempExpiresAt) : null;
  app.innerHTML = String(html`
  <div class="auth">
    ${authArt()}
    <section class="auth-form">
      <form class="auth-card" novalidate>
        <div class="head">
          <span class="badge s-pending" style="margin-bottom:12px">${ic('key')} One more step</span>
          <h1>Hi ${firstName(user.name)}, set your password</h1>
          <p>You signed in with a temporary password${exp ? html`, which expires <b>${exp.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</b>` : ''}. Choose a new one to continue.</p>
        </div>
        <div class="alert err" id="err" hidden role="alert"></div>
        ${passwordFields()}
        <button class="btn primary lg block" type="submit" data-busy=" Saving…">${ic('lock', 'sm')} Save and continue</button>
        <button class="btn ghost block" type="button" id="out">Sign out</button>
      </form>
    </section>
  </div>`);
  const form = app.querySelector('form');
  wirePasswordForm(form, { user, onSuccess: onDone, errEl: app.querySelector('#err') });
  app.querySelector('#out').addEventListener('click', onLogout);
  form.current.focus();
}
