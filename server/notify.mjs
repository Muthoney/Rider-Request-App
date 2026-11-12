// Notification service: in-app first, SMS (Africa's Talking) as the fallback.
//
//   1. Every notification is written to the recipient's in-app inbox and pushed over the live event
//      stream (and to the Android app through FCM when configured).
//   2. SMS is used when the app cannot be reached:
//        - the recipient has no live connection when a critical event happens → SMS queued at once;
//        - the recipient is connected but has not seen a critical notification within
//          `sms_fallback_seconds` (push failed, phone asleep) → SMS queued by the sweep;
//        - emergencies are escalated to dispatch by SMS immediately, without waiting.
//   3. SMS go through `sms_outbox`: a unique dedupe key per message (no duplicates, even across
//      restarts or replays), retries with backoff for temporary failures, permanent failures recorded,
//      and Africa's Talking delivery reports update the status.
// SMS needs cellular coverage on the recipient's phone and a reachable SMS gateway on the server;
// while the gateway is unreachable messages stay queued and are retried.
import { e164 } from './integrations.mjs';

const BACKOFF_S = [30, 120, 600, 1800, 3600];
const MAX_ATTEMPTS = BACKOFF_S.length + 1;
const SMS_MAX = 459; // three concatenated SMS parts

export const SMS_PREFS = ['critical', 'all', 'off'];

export function createNotifier({ db, now = () => Date.now(), integrations, hub, log = () => {}, origin }) {
  const iso = (t = now()) => new Date(t).toISOString();
  const cache = new Map();
  const st = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  const link = (p) => `${origin}/#${p}`;

  function queueSms({ companyId, userId = null, requestId = null, incidentId = null, event, phone, text, dedupe }) {
    const to = e164(phone);
    const t = iso();
    const body = String(text).replace(/\s+\n/g, '\n').slice(0, SMS_MAX);
    const status = !to ? 'skipped' : integrations.sms.configured ? 'queued' : 'skipped';
    const error = !to ? 'no valid mobile number' : integrations.sms.configured ? null : "Africa's Talking is not configured";
    const res = st(`INSERT OR IGNORE INTO sms_outbox (company_id, user_id, request_id, incident_id, event, recipient, text, dedupe_key, status, error,
      next_attempt_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(companyId, userId, requestId, incidentId, event, to || String(phone || '-'), body, dedupe, status, error, t, t, t);
    return res.changes > 0;
  }

  /**
   * Notifies users in-app, with SMS fallback. `users` are rows from `users` (need id, company_id, phone, sms_pref).
   * `dedupe` makes the call idempotent per user (repeat calls with the same key do nothing).
   */
  function notify({ users, event, title, body, linkPath = null, requestId = null, incidentId = null, critical = false, sms = null, dedupe, immediateSms = false }) {
    const out = [];
    for (const u of users) {
      if (!u) continue;
      const key = `${dedupe}:u${u.id}`;
      const t = iso();
      const res = st(`INSERT OR IGNORE INTO inbox (company_id, user_id, event, title, body, link, request_id, incident_id, critical, sms_text, dedupe_key, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(u.company_id, u.id, event, title, body, linkPath, requestId, incidentId, critical ? 1 : 0, sms, key, t);
      if (!res.changes) continue; // already notified
      const id = Number(res.lastInsertRowid);
      const item = { id, event, title, body, link: linkPath, requestId, incidentId, critical, createdAt: t };
      const live = hub.toUser(u.id, 'notification', item);
      integrations.push?.configured && background(pushTo(u.id, item));
      const pref = SMS_PREFS.includes(u.sms_pref) ? u.sms_pref : 'critical';
      const wantsSms = sms && (immediateSms || (pref !== 'off' && (critical || pref === 'all')));
      if (wantsSms && (immediateSms || !live)) {
        queueSms({ companyId: u.company_id, userId: u.id, requestId, incidentId, event, phone: u.phone, text: sms, dedupe: key });
        st('UPDATE inbox SET sms_queued_at = ? WHERE id = ?').run(t, id);
      } else if (wantsSms && !critical) {
        // Non-critical, user asked for all SMS, but they are online: no SMS needed.
        st('UPDATE inbox SET sms_queued_at = ? WHERE id = ?').run(t, id);
      }
      out.push(item);
    }
    return out;
  }

  const inflight = new Set();
  const background = (p) => { const x = p.catch((err) => log('error', err)).finally(() => inflight.delete(x)); inflight.add(x); return x; };

  async function pushTo(userId, item) {
    const tokens = st('SELECT token FROM push_tokens WHERE user_id = ?').all(userId).map((r) => r.token);
    for (const token of tokens) {
      try { await integrations.push.send({ token, title: item.title, body: item.body, data: { link: item.link || '', id: String(item.id) } }); }
      catch (err) {
        if (err.unregistered) st('DELETE FROM push_tokens WHERE token = ?').run(token);
        else log('error', `Push failed: ${err.message}`);
      }
    }
  }

  /** Critical in-app notifications nobody has seen in time get an SMS. */
  function sweep() {
    const rows = st(`SELECT i.*, u.phone, u.sms_pref, COALESCE(o.sms_fallback_seconds, 90) AS wait
      FROM inbox i JOIN users u ON u.id = i.user_id LEFT JOIN ops_settings o ON o.company_id = i.company_id
      WHERE i.critical = 1 AND i.seen_at IS NULL AND i.sms_queued_at IS NULL AND i.sms_text IS NOT NULL AND i.created_at >= ?
      LIMIT 200`).all(iso(now() - 24 * 3600e3));
    for (const r of rows) {
      if (new Date(r.created_at).getTime() + r.wait * 1000 > now()) continue;
      if (r.sms_pref !== 'off') {
        queueSms({ companyId: r.company_id, userId: r.user_id, requestId: r.request_id, incidentId: r.incident_id, event: r.event, phone: r.phone, text: r.sms_text, dedupe: r.dedupe_key });
      }
      st('UPDATE inbox SET sms_queued_at = ? WHERE id = ?').run(iso(), r.id);
    }
  }

  let running = false;
  /** Sends due SMS. Safe to call often; one batch at a time. */
  async function processOutbox() {
    if (running || !integrations.sms.configured) return;
    running = true;
    try {
      // Rows left "sending" by a crash go back to the queue.
      st(`UPDATE sms_outbox SET status = 'queued' WHERE status = 'sending' AND updated_at < ?`).run(iso(now() - 120e3));
      const due = st(`SELECT * FROM sms_outbox WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY id LIMIT 20`).all(iso());
      for (const m of due) {
        const claimed = st(`UPDATE sms_outbox SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'queued'`).run(iso(), m.id);
        if (!claimed.changes) continue;
        try {
          const { id } = await integrations.sms.send({ to: m.recipient, text: m.text });
          st(`UPDATE sms_outbox SET status = 'sent', provider_id = ?, attempts = attempts + 1, error = NULL, updated_at = ? WHERE id = ?`).run(id || null, iso(), m.id);
        } catch (err) {
          const attempts = m.attempts + 1;
          const final = err.permanent || attempts >= MAX_ATTEMPTS;
          st(`UPDATE sms_outbox SET status = ?, attempts = ?, error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`)
            .run(final ? 'failed' : 'queued', attempts, String(err.message).slice(0, 300), iso(now() + (BACKOFF_S[attempts - 1] || 3600) * 1000), iso(), m.id);
          if (final) log('error', `SMS ${m.id} (${m.event}) failed: ${err.message}`);
        }
      }
    } finally { running = false; }
  }

  /** Africa's Talking delivery report (id, status, failureReason). */
  function deliveryReport({ id, status, failureReason }) {
    if (!id) return false;
    const s = String(status || '').toLowerCase();
    const mapped = s === 'success' ? 'delivered' : ['failed', 'rejected', 'aborted'].includes(s) ? 'failed' : null;
    if (!mapped) return false;
    const err = mapped === 'failed' ? String(failureReason || status).slice(0, 300) : null;
    const a = st(`UPDATE sms_outbox SET status = ?, error = COALESCE(?, error), updated_at = ? WHERE provider_id = ?`).run(mapped, err, iso(), String(id));
    const b = st(`UPDATE notifications SET status = ?, error = COALESCE(?, error), updated_at = ? WHERE provider_id = ? AND channel = 'sms'`).run(mapped, err, iso(), String(id));
    return a.changes + b.changes > 0;
  }

  let timer = null;
  const tick = async () => { try { sweep(); await processOutbox(); } catch (err) { log('error', err); } };
  return {
    notify, queueSms, sweep, processOutbox, deliveryReport, tick, link,
    start(intervalMs = 5000) { if (!timer) { timer = setInterval(tick, intervalMs); timer.unref?.(); } },
    stop() { if (timer) clearInterval(timer); timer = null; },
    idle: () => Promise.allSettled([...inflight]),
  };
}

// ---------- message templates (short enough for one or two SMS parts) ----------
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
export const TEMPLATES = {
  accepted: ({ ref, rider, phone, url }) => ({
    title: `${ref} accepted`, body: `${rider} is on the way to the pickup.`,
    sms: `${ref}: ${rider}${phone ? ` (${phone})` : ''} accepted your delivery and is heading to the pickup. Track: ${url}`,
  }),
  assignedRequester: ({ ref, rider, phone, url }) => ({
    title: `${ref}: rider assigned`, body: `${rider} will handle your delivery.`,
    sms: `${ref}: ${rider}${phone ? ` (${phone})` : ''} has been assigned to your delivery. Track: ${url}`,
  }),
  collected: ({ ref, rider, stops, url }) => ({
    title: `${ref} picked up`, body: `${rider} collected the items and is heading to ${stops} drop-off${stops === 1 ? '' : 's'}.`,
    sms: `${ref}: picked up by ${rider}, on the way to ${stops} drop-off${stops === 1 ? '' : 's'}. Track: ${url}`,
  }),
  dropoffDone: ({ ref, seq, receivedBy, time }) => ({
    title: `${ref}: drop-off ${seq} delivered`, body: `Received by ${receivedBy} at ${time}.`,
    sms: `${ref}: drop-off ${seq} delivered to ${clip(receivedBy, 40)} at ${time}.`,
  }),
  dropoffFailed: ({ ref, seq, note }) => ({
    title: `${ref}: drop-off ${seq} not delivered`, body: clip(note, 140),
    sms: `${ref}: drop-off ${seq} could not be delivered: ${clip(note, 80)}. Dispatch will follow up.`,
  }),
  delivered: ({ ref, url }) => ({
    title: `${ref} delivered`, body: 'All drop-offs are complete. Rate the rider.',
    sms: `${ref} is delivered. Please rate your rider: ${url}`,
  }),
  locationChanged: ({ ref, what, address, by }) => ({
    title: `${ref}: ${what} changed`, body: `New ${what}: ${clip(address, 120)} (by ${by}). Confirm in the app.`,
    sms: `CHANGE ${ref}: ${what} is now ${clip(address, 90)}. Open the app to confirm.`,
  }),
  emergency: ({ rider, phone, type, ref, mapUrl }) => ({
    title: `EMERGENCY: ${type} — ${rider}`, body: `${rider} reported ${type}${ref ? ` on ${ref}` : ''}.`,
    sms: `EMERGENCY: ${rider}${phone ? ` (${phone})` : ''} reported ${type}${ref ? ` on ${ref}` : ''}.${mapUrl ? ` Location: ${mapUrl}` : ''}`,
  }),
  incidentAck: ({ by, type }) => ({ title: 'Dispatch has your report', body: `${by} acknowledged your ${type} report.`, sms: `Dispatch (${by}) received your ${type} report and is responding.` }),
  announcement: ({ from, text }) => ({ title: `Announcement from ${from}`, body: clip(text, 300), sms: `Dispatch: ${clip(text, 300)}` }),
  overtimeRequest: ({ rider, minutes }) => ({ title: `Overtime request: ${rider}`, body: `${rider} asks for ${minutes} min overtime.`, sms: null }),
  overtimeDecision: ({ status, minutes, by }) => ({
    title: `Overtime ${status}`, body: `${by} ${status} ${minutes} min overtime.`, sms: `Your overtime request (${minutes} min) was ${status} by ${by}.`,
  }),
  shiftOver: ({ hours }) => ({ title: 'Standard shift reached', body: `You've worked ${hours} h. Request overtime or clock out.`, sms: null }),
  recipientOnTheWay: ({ ref, company, rider, phone }) => ({
    sms: `Your delivery ${ref} from ${clip(company, 30)} is on the way with ${rider}${phone ? ` (${phone})` : ''}.`,
  }),
};
