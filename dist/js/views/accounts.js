import { api } from '../api.js';
import { html, ic, avatar, roleBadge, tagBadges, timeAgo, openModal, toast, confirmDialog, busy, ROLE_LABEL, empty } from '../ui.js';

function tempPasswordDialog(user, password) {
  return openModal({
    title: 'Temporary password issued', subtitle: `Share it privately with ${user.name}. It is shown only once and expires in 72 hours.`, iconName: 'key',
    body: html`
      <div class="field"><span class="label">Email</span><div class="input mono" style="display:flex;align-items:center">${user.email}</div></div>
      <div class="field"><span class="label">Temporary password</span>
        <div class="row"><input class="input mono" id="tp" readonly value="${password}" style="font-size:16px;letter-spacing:.04em"><button type="button" class="btn" id="copy">${ic('copy', 'sm')} Copy</button></div></div>
      <div class="alert info">${ic('lock', 'sm')}<span>They'll be asked to replace it with a password of at least 12 characters when they first sign in.</span></div>`,
    actions: html`<button class="btn primary" type="submit">Done</button>`,
    onMount: ({ form, close, el }) => {
      el.querySelector('#copy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(password); toast('Copied to clipboard'); } catch { el.querySelector('#tp').select(); toast('Press Ctrl+C to copy', 'warn'); }
      });
      form.addEventListener('submit', (e) => { e.preventDefault(); close(true); });
    },
  });
}

function accountForm(u = null) {
  return html`
    <div class="form-grid">
      <div class="field"><label for="an">Full name</label><input class="input" id="an" name="name" required maxlength="120" value="${u?.name || ''}" autofocus></div>
      <div class="field"><label for="ae">Email</label><input class="input" id="ae" name="email" type="email" required value="${u?.email || ''}" ${u ? 'disabled' : ''}></div>
      <div class="field"><label for="ap">Phone</label><input class="input" id="ap" name="phone" type="tel" value="${u?.phone || ''}" placeholder="+254 7…"></div>
      <div class="field"><label for="ar">Role</label><select class="input" id="ar" name="role">${Object.entries(ROLE_LABEL).map(([k, l]) => html`<option value="${k}" ${(u?.role || 'requester') === k ? 'selected' : ''}>${l}</option>`)}</select></div>
      <div class="field full" data-tags>
        <span class="label">Rider designations</span>
        <div class="chips">
          <label class="chip"><input type="checkbox" name="tags" value="triangle" ${u?.tags?.includes('triangle') ? 'checked' : ''}>${ic('triangle', 'sm')} Triangle</label>
          <label class="chip"><input type="checkbox" name="tags" value="finance" ${u?.tags?.includes('finance') ? 'checked' : ''}>${ic('coins', 'sm')} Finance</label>
        </div>
        <span class="hint">Designated riders get reserved work; assigning them other jobs while reserved work waits needs a recorded override.</span>
      </div>
    </div>
    <p class="error-text" id="aerr" hidden></p>`;
}

export async function render(el, ctx) {
  let { users } = await api.get('/api/users');
  let roleFilter = 'all';
  let q = '';

  const editDialog = (u) => openModal({
    title: u ? `Edit ${u.name}` : 'Create account', subtitle: u ? u.email : 'A temporary password is generated for the first sign-in.', iconName: u ? 'edit' : 'user',
    body: accountForm(u),
    actions: html`<button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${u ? 'Save changes' : 'Create account'}</button>`,
    onMount: ({ form, close }) => {
      const sync = () => { form.querySelector('[data-tags]').hidden = form.role.value !== 'rider'; };
      form.role.addEventListener('change', sync); sync();
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = form.querySelector('#aerr');
        const body = {
          name: form.name.value.trim(), phone: form.phone.value.trim() || null, role: form.role.value,
          tags: [...form.querySelectorAll('[name=tags]:checked')].map((x) => x.value),
        };
        if (!body.name) { err.textContent = 'Enter a name.'; err.hidden = false; return; }
        try {
          const res = u ? await api.patch(`/api/users/${u.id}`, body) : await api.post('/api/users', { ...body, email: form.email.value.trim() });
          close(res);
        } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      });
    },
  });

  const paint = () => {
    const list = users.filter((u) => (roleFilter === 'all' || u.role === roleFilter) &&
      (!q || `${u.name} ${u.email}`.toLowerCase().includes(q.toLowerCase())));
    const count = (r) => users.filter((u) => r === 'all' || u.role === r).length;
    el.innerHTML = String(html`
      <div class="page-head">
        <div><h1>Manage accounts</h1><p>Create accounts, set roles and rider designations, and issue temporary passwords.</p></div>
        <button class="btn primary" id="create">${ic('plus', 'sm')} Create account</button>
      </div>
      <div class="tabs">${['all', 'admin', 'manager', 'dispatcher', 'requester', 'rider'].map((r) => html`
        <button data-r="${r}" class="${roleFilter === r ? 'on' : ''}">${r === 'all' ? 'Everyone' : ROLE_LABEL[r] + 's'}<span class="n">${count(r)}</span></button>`)}</div>
      <div class="toolbar"><div class="search" style="width:320px">${ic('search', 'sm')}<input id="uq" value="${q}" placeholder="Search name or email" aria-label="Search accounts"></div></div>
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>Person</th><th>Role</th><th class="hide-sm">Status</th><th class="hide-sm">Last sign-in</th><th style="text-align:right">Actions</th></tr></thead>
        <tbody>${list.map((u) => html`
          <tr style="${u.active ? '' : 'opacity:.55'}">
            <td><div class="row">${avatar(u.name)}<div><b>${u.name}</b>${u.id === ctx.user.id ? html` <span class="badge b-outline">You</span>` : ''}<div class="req-sub">${u.email}${u.phone ? ` · ${u.phone}` : ''}</div></div></div></td>
            <td><div class="row wrap" style="gap:6px">${roleBadge(u.role)}${tagBadges(u.tags)}</div></td>
            <td class="hide-sm">${!u.active ? html`<span class="badge s-cancelled dot">Deactivated</span>`
              : u.mustChange ? html`<span class="badge s-pending dot" title="Expires ${new Date(u.tempExpiresAt).toLocaleString()}">${new Date(u.tempExpiresAt) < new Date() ? 'Temp password expired' : 'Awaiting first sign-in'}</span>`
              : html`<span class="badge s-delivered dot">Active</span>`}</td>
            <td class="hide-sm muted">${u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'Never'}</td>
            <td style="text-align:right;white-space:nowrap">
              <button class="btn sm ghost" data-edit="${u.id}" aria-label="Edit ${u.name}">${ic('edit', 'sm')}</button>
              <button class="btn sm ghost" data-reset="${u.id}" title="Issue temporary password" aria-label="Issue temporary password for ${u.name}">${ic('key', 'sm')}</button>
              ${u.id !== ctx.user.id ? html`<button class="btn sm ghost ${u.active ? 'danger' : ''}" data-toggle="${u.id}">${u.active ? 'Deactivate' : 'Reactivate'}</button>` : ''}
            </td>
          </tr>`)}</tbody></table>
        ${list.length ? '' : empty('users', 'No accounts', 'No one matches this filter.')}</div></div>`);

    el.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => { roleFilter = b.dataset.r; paint(); }));
    const input = el.querySelector('#uq');
    input.addEventListener('input', () => { q = input.value; const p = input.selectionStart; paint(); const i = el.querySelector('#uq'); i.focus(); i.setSelectionRange(p, p); });
    el.querySelector('#create').addEventListener('click', async () => {
      const res = await editDialog(null);
      if (!res) return;
      users.push(res.user); paint();
      await tempPasswordDialog(res.user, res.tempPassword);
    });
    el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', async () => {
      const res = await editDialog(users.find((u) => u.id === +b.dataset.edit));
      if (res) { users = users.map((u) => (u.id === res.user.id ? res.user : u)); toast('Account updated'); paint(); }
    }));
    el.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', async () => {
      const u = users.find((x) => x.id === +b.dataset.reset);
      if (!(await confirmDialog({ title: `Issue a temporary password to ${u.name}?`, message: 'Their current password stops working and they are signed out everywhere.', confirm: 'Issue password', iconName: 'key' }))) return;
      await busy(b, async () => {
        try {
          const res = await api.post(`/api/users/${u.id}/reset-password`);
          users = users.map((x) => (x.id === u.id ? res.user : x)); paint();
          await tempPasswordDialog(res.user, res.tempPassword);
        } catch (e) { toast(e.message, 'err'); }
      });
    }));
    el.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
      const u = users.find((x) => x.id === +b.dataset.toggle);
      if (u.active && !(await confirmDialog({ title: `Deactivate ${u.name}?`, message: 'They are signed out immediately and cannot sign in until reactivated. Their history is kept.', confirm: 'Deactivate', danger: true }))) return;
      try {
        const res = await api.patch(`/api/users/${u.id}`, { active: !u.active });
        users = users.map((x) => (x.id === u.id ? res.user : x)); toast(res.user.active ? 'Account reactivated' : 'Account deactivated'); paint();
      } catch (e) { toast(e.message, 'err'); }
    }));
  };
  paint();
}
