// 文件权限加固：把「只有当前用户可读写」这件事真正落实，而不是 try{chmod}catch{} 静默吞掉。
// POSIX: chmod 0600。Windows: 取当前用户 SID，用参数数组调用 icacls 关闭继承并只授予该 SID。
// 这里刻意不用 shell 字符串、也不走管道 stdio（管道在受限环境会被拒，且大输出易死锁），
// 而是把子进程输出重定向到临时文件再读回来 —— 结果确定、无死锁。
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';

// 同步执行外部命令（harden 必须同步：它要在 atomicWrite 这类同步写入路径里使用）。
function runSync(cmd, args, options) {
  const opts = options || {};
  let scratch = null;
  let fdOut = null, fdErr = null;
  try {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fileperm-'));
    const outFile = path.join(scratch, 'out.txt');
    const errFile = path.join(scratch, 'err.txt');
    fdOut = fs.openSync(outFile, 'w');
    fdErr = fs.openSync(errFile, 'w');
    let status = 1, error = null, signal = null;
    try {
      const res = cp.spawnSync(cmd, (args || []).map(String), {
        stdio: ['ignore', fdOut, fdErr], windowsHide: true, shell: false, timeout: opts.timeout || 15000,
      });
      status = typeof res.status === 'number' ? res.status : 1;
      signal = res.signal || null;
      error = res.error ? String(res.error.message || res.error) : null;
    } catch (error2) { status = 1; error = String((error2 && error2.message) || error2); }
    fs.closeSync(fdOut); fdOut = null;
    fs.closeSync(fdErr); fdErr = null;
    return { status: status, signal: signal, error: error,
      stdout: fs.readFileSync(outFile, 'utf8'), stderr: fs.readFileSync(errFile, 'utf8') };
  } catch (error) {
    return { status: 1, signal: null, error: String((error && error.message) || error), stdout: '', stderr: '' };
  } finally {
    if (fdOut != null) { try { fs.closeSync(fdOut); } catch (e) {} }
    if (fdErr != null) { try { fs.closeSync(fdErr); } catch (e) {} }
    if (scratch) { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) {} }
  }
}

// 当前用户身份：SID 用于授权，name（domain\user）用于解析 icacls 的显示形式。
export function currentUser(options) {
  const run = (options && options.run) || runSync;
  const out = { sid: null, name: null };
  const whoami = run('whoami', []);
  if (whoami.status === 0 && whoami.stdout.trim()) out.name = whoami.stdout.trim().split(/\r?\n/)[0].trim();
  const sid = run('whoami', ['/user', '/fo', 'csv', '/nh']);
  if (sid.status === 0) {
    const m = String(sid.stdout || '').match(/"(S-\d+-\d+[0-9-]+)"/);
    if (m) out.sid = m[1];
  }
  return out;
}

function resolveFile(filePath) {
  const raw = String(filePath == null ? '' : filePath);
  if (!raw.trim()) return null;
  return path.resolve(raw);
}

// harden(filePath) -> { ok, method: 'posix'|'icacls'|'unsupported', detail }
export function harden(filePath, options) {
  const file = resolveFile(filePath);
  if (!file) return { ok: false, method: 'unsupported', detail: '空路径' };
  if (!fs.existsSync(file)) return { ok: false, method: 'unsupported', detail: '文件不存在: ' + file };
  const run = (options && options.run) || runSync;
  // 注入桩即视为要测 icacls 分支：否则 Windows 逻辑在 POSIX 上永远测不到
  // （生产从不传 run/user，行为不变）。
  const forced = !!(options && (options.run || options.user || options.forceIcacls));
  if (!IS_WIN && !forced) {
    try {
      fs.chmodSync(file, 0o600);
      const mode = fs.statSync(file).mode & 0o777;
      const ok = (mode & 0o077) === 0;
      return { ok: ok, method: 'posix', detail: ok ? '权限已收窄为 ' + mode.toString(8) : '仍可被其他用户访问: ' + mode.toString(8) };
    } catch (error) {
      return { ok: false, method: 'posix', detail: String((error && error.message) || error) };
    }
  }
  const user = options && options.user ? options.user : currentUser({ run: run });
  if (!user || !user.sid) return { ok: false, method: 'icacls', detail: '取不到当前用户 SID，拒绝假装加固成功' };
  const strip = run('icacls', [file, '/inheritance:r']);
  if (strip.status !== 0) {
    return { ok: false, method: 'icacls', detail: '关闭继承失败: ' + String(strip.stderr || strip.stdout || strip.error || '').slice(0, 300) };
  }
  // icacls 里 SID 必须写成 *S-1-5-...，否则它会当成账户名去解析，
  // 在 CI runner 上报「No mapping between account names and security IDs」。
  const grant = run('icacls', [file, '/grant:r', '*' + user.sid + ':F']);
  if (grant.status !== 0) {
    return { ok: false, method: 'icacls', detail: '授予当前用户失败: ' + String(grant.stderr || grant.stdout || grant.error || '').slice(0, 300) };
  }
  return { ok: true, method: 'icacls', detail: 'inheritance:r + 仅授 ' + user.sid };
}

// icacls 输出里的受托人：domain\user、NT AUTHORITY\SYSTEM、裸 SID 三种形式都要认。
const ACE_RE = /((?:[A-Za-z0-9_.-]+\\[A-Za-z0-9_. $+-]+)|(?:S-\d+-\d+[0-9-]+)|(?:NT AUTHORITY\\[A-Za-z ]+)):((?:\([^)]*\))+)/g;

// icacls 会把「文件路径」和第一个受托人印在同一行（路径 + 空格 + 受托人:(权限)），
// 先把路径抠掉，否则路径尾巴会被当成受托人名字。
function stripPaths(text, file) {
  let out = String(text || '');
  out = out.split(file).join(' ');
  out = out.split(path.dirname(file)).join(' ');
  return out;
}

function principalsOf(text) {
  const found = [];
  ACE_RE.lastIndex = 0;
  let m;
  while ((m = ACE_RE.exec(String(text || ''))) !== null) {
    found.push({ principal: m[1].trim(), rights: m[2].trim() });
  }
  return found;
}

// verify(filePath) -> { ok, detail }：读实际 ACL / 模式位，doctor 用它判定就绪。
export function verify(filePath, options) {
  const file = resolveFile(filePath);
  if (!file) return { ok: false, method: 'unsupported', detail: '空路径' };
  if (!fs.existsSync(file)) return { ok: false, method: 'unsupported', detail: '文件不存在: ' + file };
  const run = (options && options.run) || runSync;
  const forced = !!(options && (options.run || options.user || options.forceIcacls));
  if (!IS_WIN && !forced) {
    try {
      const mode = fs.statSync(file).mode & 0o777;
      const ok = (mode & 0o077) === 0;
      return { ok: ok, method: 'posix', detail: ok ? '仅 owner 可读写: ' + mode.toString(8) : '其他用户仍可访问: ' + mode.toString(8) };
    } catch (error) {
      return { ok: false, method: 'posix', detail: String((error && error.message) || error) };
    }
  }
  const user = options && options.user ? options.user : currentUser({ run: run });
  if (!user || !user.sid) return { ok: false, method: 'icacls', detail: '取不到当前用户 SID，无法判定' };
  const out = run('icacls', [file]);
  if (out.status !== 0) {
    return { ok: false, method: 'icacls', detail: '读取 ACL 失败: ' + String(out.stderr || out.stdout || out.error || '').slice(0, 300) };
  }
  const text = stripPaths(out.stdout, file);
  const entries = principalsOf(text);
  if (!entries.length) return { ok: false, method: 'icacls', detail: '解析不出任何 ACL 条目: ' + text.slice(0, 200) };
  // Windows 的账户名比较不区分大小写（icacls 常输出 RUNNERADMIN\runneradmin，而 whoami 给 runneradmin\runneradmin）。
  const lower = function (v) { return String(v || '').toLowerCase(); };
  const self = [user.sid, user.name, user.name ? user.name.split('\\').pop() : null].filter(Boolean).map(lower);
  const others = [];
  let inherited = false;
  for (const entry of entries) {
    if (/\(I\)/.test(entry.rights) || /inherited/i.test(entry.rights)) inherited = true;
    if (self.indexOf(lower(entry.principal)) < 0) others.push(entry.principal);
  }
  if (inherited) return { ok: false, method: 'icacls', detail: '仍存在继承来的 ACL（应关闭继承）' };
  if (others.length) return { ok: false, method: 'icacls', detail: '存在额外受托人: ' + Array.from(new Set(others)).slice(0, 5).join(', ') };
  return { ok: true, method: 'icacls', detail: '仅 ' + (user.name || user.sid) + ' 可访问' };
}

export const FILE_PERMISSIONS_PLATFORM = IS_WIN ? 'win32' : process.platform;
export { runSync as runPermissionCommand };
