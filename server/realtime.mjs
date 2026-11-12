// Real-time updates over Server-Sent Events (plain HTTPS, works through proxies and mobile networks).
// Each signed-in browser or app keeps one GET /api/events stream open. The server pushes small
// "something changed" events; clients then re-fetch what they show. Nothing here is authoritative:
// a client that misses events catches up on its next poll or reconnect.

const HEARTBEAT_MS = 25_000;

export function createHub({ now = () => Date.now() } = {}) {
  /** connection id -> { res, userId, companyId, role } */
  const conns = new Map();
  let nextId = 1;
  let timer = null;

  const write = (c, event, data) => {
    try { c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); return true; } catch { return false; }
  };

  function ensureHeartbeat() {
    if (timer || !conns.size) return;
    timer = setInterval(() => {
      for (const c of conns.values()) { try { c.res.write(`: ping ${now()}\n\n`); } catch {} }
      if (!conns.size) { clearInterval(timer); timer = null; }
    }, HEARTBEAT_MS);
    timer.unref?.();
  }

  return {
    /** Takes over `res` as an event stream for `user`. */
    attach(req, res, user, headers = {}) {
      res.writeHead(200, {
        ...headers,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // nginx: do not buffer the stream
      });
      res.write('retry: 5000\n\n');
      const id = nextId++;
      const c = { res, userId: user.id, companyId: user.company_id, role: user.role };
      conns.set(id, c);
      write(c, 'hello', { at: new Date(now()).toISOString() });
      const drop = () => conns.delete(id);
      req.on('close', drop);
      res.on('error', drop);
      ensureHeartbeat();
    },
    /** Sends to every connection of a company that passes `filter(conn)`. */
    publish(companyId, event, data, filter = () => true) {
      for (const c of conns.values()) if (c.companyId === companyId && filter(c)) write(c, event, data);
    },
    /** Sends to one user's connections. Returns how many connections received it. */
    toUser(userId, event, data) {
      let n = 0;
      for (const c of conns.values()) if (c.userId === userId && write(c, event, data)) n++;
      return n;
    },
    isOnline: (userId) => [...conns.values()].some((c) => c.userId === userId),
    onlineUsers: (companyId) => new Set([...conns.values()].filter((c) => c.companyId === companyId).map((c) => c.userId)),
    close() {
      for (const c of conns.values()) { try { c.res.end(); } catch {} }
      conns.clear();
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}
