import crypto from 'node:crypto';

// AgentBus 凭据：库里只存 SHA-256，原文只在签发时返回一次。
// human 永不签发 MCP 凭据，因此 --agent human 拿不到管理权限。
const DEFAULT_GRACE_MS = 5 * 60 * 1000;
const REDACT_KEY = /token|secret|cookie|password|authorization|credential/i;
const MAX_FIELD = 500;

function nowIso() { return new Date().toISOString(); }
function isoOf(ms) { return new Date(ms).toISOString(); }

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function authFail(reason) {
  const messages = {
    auth_required: '缺少或无效的 AgentBus 凭据',
    expired: '凭据已过期',
    revoked: '凭据已被撤销',
  };
  return { ok: false, reason: reason, message: messages[reason] || '认证失败' };
}

export function issueCredential(db, agentId, opts) {
  const options = opts || {};
  if (typeof agentId !== 'string' || !agentId.trim()) {
    return { ok: false, reason: 'invalid_agent', message: 'agent_id 必须是非空字符串' };
  }
  if (agentId === 'human') {
    return { ok: false, reason: 'human_credentials_forbidden', message: 'human 永不签发 MCP 凭据' };
  }
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const createdAt = nowIso();
  const expiresAt = options.expiresInMs ? isoOf(Date.now() + Number(options.expiresInMs)) : (options.expiresAt || null);
  db.prepare('INSERT INTO agent_credentials(agent_id,token_hash,created_at,expires_at,revoked_at,last_used_at) VALUES(?,?,?,?,NULL,NULL)')
    .run(agentId, tokenHash, createdAt, expiresAt);
  return { ok: true, token: token, record: { agent_id: agentId, token_hash: tokenHash, created_at: createdAt, expires_at: expiresAt } };
}

export function verifyCredential(db, token) {
  if (typeof token !== 'string' || !token) return authFail('auth_required');
  const presented = hashToken(token);
  const row = db.prepare('SELECT agent_id,token_hash,expires_at,revoked_at FROM agent_credentials WHERE token_hash=?').get(presented);
  if (!row) return authFail('auth_required');
  const stored = Buffer.from(String(row.token_hash), 'utf8');
  const candidate = Buffer.from(presented, 'utf8');
  if (stored.length !== candidate.length || !crypto.timingSafeEqual(stored, candidate)) return authFail('auth_required');
  if (row.revoked_at) return authFail('revoked');
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return authFail('expired');
  db.prepare('UPDATE agent_credentials SET last_used_at=? WHERE token_hash=?').run(nowIso(), presented);
  return { ok: true, agent: row.agent_id };
}

export function revokeCredential(db, agentId) {
  const result = db.prepare('UPDATE agent_credentials SET revoked_at=? WHERE agent_id=? AND revoked_at IS NULL').run(nowIso(), agentId);
  return { ok: true, revoked: Number(result.changes) };
}

// 5 分钟双 token 窗口：新 token 生效，旧 token 拿到宽限期而不是立刻失效。
export function rotateCredential(db, agentId, opts) {
  const options = opts || {};
  const graceMs = Number.isSafeInteger(options.graceMs) ? options.graceMs : DEFAULT_GRACE_MS;
  const issued = issueCredential(db, agentId, options);
  if (!issued.ok) return issued;
  const graceUntil = isoOf(Date.now() + graceMs);
  db.prepare('UPDATE agent_credentials SET expires_at=? WHERE agent_id=? AND revoked_at IS NULL AND token_hash<>?')
    .run(graceUntil, agentId, issued.record.token_hash);
  return { ok: true, token: issued.token, grace_until: graceUntil, record: issued.record };
}

export function revokeSuperseded(db, agentId) {
  // 用 rowid 而不是 created_at：同一毫秒内签发多张凭据时时间戳会并列，会把新凭据当成旧的撤销掉。
  const newest = db.prepare('SELECT token_hash FROM agent_credentials WHERE agent_id=? AND revoked_at IS NULL ORDER BY rowid DESC LIMIT 1').get(agentId);
  if (!newest) return { ok: true, revoked: 0 };
  const result = db.prepare('UPDATE agent_credentials SET revoked_at=? WHERE agent_id=? AND revoked_at IS NULL AND token_hash<>?')
    .run(nowIso(), agentId, newest.token_hash);
  return { ok: true, revoked: Number(result.changes) };
}

function redact(value, depth) {
  const level = depth || 0;
  if (value == null) return value;
  if (typeof value === 'string') {
    if (/^[A-Za-z0-9_-]{32,}$/.test(value)) return '[redacted]';
    return value.length > MAX_FIELD ? value.slice(0, MAX_FIELD) + '…' : value;
  }
  if (typeof value !== 'object') return value;
  if (level >= 3) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, 20).map(function (item) { return redact(item, level + 1); });
  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = REDACT_KEY.test(key) ? '[redacted]' : redact(value[key], level + 1);
  }
  return out;
}

// 审计只增不改；token、cookie、请求正文一律不入库。
export function logAudit(db, entry) {
  const e = entry || {};
  const resource = e.resource == null ? null : JSON.stringify(redact(e.resource));
  db.prepare('INSERT INTO audit_log(actor,auth_method,action,resource,result,remote_addr,ts) VALUES(?,?,?,?,?,?,?)')
    .run(String(e.actor || 'unknown').slice(0, 80), String(e.auth_method || 'unknown').slice(0, 40),
      String(e.action || 'unknown').slice(0, 80), resource, String(e.result || 'unknown').slice(0, 40),
      e.remote_addr ? String(e.remote_addr).slice(0, 60) : null, nowIso());
  return { ok: true };
}

export function listAudit(db, limit) {
  const max = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
  return db.prepare('SELECT actor,auth_method,action,resource,result,remote_addr,ts FROM audit_log ORDER BY id DESC LIMIT ?').all(max);
}

export { redact };
