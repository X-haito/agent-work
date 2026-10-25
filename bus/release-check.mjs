// 发布检查（第 12 项第 6 条）：跑全部 smoke + doctor + 打包清单检查，确认 tarball 不含运行数据。
// 沙箱里没有 npm 也不许管道 stdio：这里用「输出重定向到临时文件」的方式跑子进程，并诚实标注 skip。
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from './store.mjs';

const SPECIALS = ['\\', '^', '$', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|'];
const ANYDIR = String.fromCharCode(1);
const ANY = String.fromCharCode(2);

export function globToRegExp(glob) {
  let s = String(glob).split('**/').join(ANYDIR).split('**').join(ANY);
  let out = '';
  for (const ch of s) {
    if (ch === ANYDIR) out += '(?:[^/]+/)*';
    else if (ch === ANY) out += '.*';
    else if (ch === '*') out += '[^/]*';
    else if (SPECIALS.indexOf(ch) >= 0) out += String.fromCharCode(92) + ch;
    else out += ch;
  }
  return new RegExp('^' + out + '$');
}

// 敏感文件：只要命中任何一条就说明打包含进了运行数据/凭据/备份。
export const SENSITIVE_PATTERNS = [
  { id: 'database', re: /(^|\/)bus\.db($|-wal$|-shm$)/i, why: '数据库（含 WAL/SHM）' },
  { id: 'logs', re: /(^|\/)logs\//i, why: '日志目录' },
  { id: 'projects', re: /(^|\/)projects\.json$/i, why: '项目注册表' },
  { id: 'policy', re: /(^|\/)policy\.json$/i, why: '用户策略' },
  { id: 'workspaces', re: /(^|\/)workspaces\//i, why: '工作区' },
  { id: 'manifest', re: /(^|\/)install-manifest\.json$/i, why: '安装清单' },
  // 第 15 项第 10 条：生命周期运行状态（pid/启动时间/待重启标记）与任何 PID 文件都属于运行数据。
  // 变体（lifecycle.json / lifecycle.bak-1.json / lifecycle.json.tmp-x）一律拦：改名不该绕过规则。
  { id: 'lifecycle', re: /(^|\/)lifecycle[^/]*\.json(\.bak-|\.tmp-)?.*$/i, why: '生命周期运行状态（PID/重启标记）' },
  { id: 'pidfile', re: /\.pid$/i, why: 'PID 文件' },
  { id: 'backup', re: /\.bak-|\.tmp-|~$/i, why: '备份/临时文件' },
  // 只认真正的凭据文件名（别把 bus/migrations/005-credential-state.mjs 这种代码误判成凭据）。
  { id: 'credentials', re: /(^|\/)(credentials?|secrets?)\.(json|ya?ml|txt|env)$|\.pem$|(^|\/)id_(rsa|ed25519)$|(^|\/)\.env$/i, why: '凭据' },
];

export function inspectPack(options) {
  const o = options || {};
  const root = path.resolve(o.root || path.resolve(S.BUS_DIR, '..'));
  const pkgFile = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  const patterns = (pkg.files || []).map(globToRegExp);
  const files = [];
  function walk(dir, rel) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      const relPath = (rel ? rel + '/' : '') + entry.name;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(path.join(dir, entry.name), relPath);
        continue;
      }
      if (patterns.some(function (re) { return re.test(relPath); })) {
        let bytes = 0;
        try { bytes = fs.statSync(path.join(dir, entry.name)).size; } catch (e) { bytes = 0; }
        files.push({ path: relPath, bytes: bytes });
      }
    }
  }
  walk(root, '');
  for (const extra of ['README.md', 'package.json']) {
    if (patterns.some(function (re) { return re.test(extra); }) && !files.some(function (f) { return f.path === extra; }) && fs.existsSync(path.join(root, extra))) {
      files.push({ path: extra, bytes: fs.statSync(path.join(root, extra)).size });
    }
  }
  files.sort(function (a, b) { return a.path < b.path ? -1 : 1; });
  const violations = [];
  for (const file of files) {
    for (const rule of SENSITIVE_PATTERNS) {
      if (rule.re.test(file.path)) violations.push({ path: file.path, rule: rule.id, why: rule.why });
    }
  }
  return { ok: violations.length === 0, version: String(pkg.version || '0.0.0'), files: files, violations: violations,
    total_bytes: files.reduce(function (n, f) { return n + f.bytes; }, 0) };
}

// 无管道执行器：stdout/stderr 重定向到临时文件再读回（沙箱禁管道，也不会有死锁）。
export function fileExec(cmd, args, options) {
  const o = options || {};
  return new Promise(function (resolve) {
    let scratch = null, fdOut = null, fdErr = null;
    try {
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'release-check-'));
      const outFile = path.join(scratch, 'out.txt');
      const errFile = path.join(scratch, 'err.txt');
      fdOut = fs.openSync(outFile, 'w');
      fdErr = fs.openSync(errFile, 'w');
      const extraEnv = o.env || {};
      const child = cp.spawn(cmd, args, {
        cwd: o.cwd, stdio: ['ignore', fdOut, fdErr], windowsHide: true, shell: false,
        env: Object.assign({}, process.env, extraEnv),
      });
      child.on('error', function (error) {
        try { fs.closeSync(fdOut); fs.closeSync(fdErr); } catch (e) {}
        resolve({ code: 1, stdout: '', stderr: '', error: String((error && error.message) || error) });
      });
      child.on('close', function (code) {
        try { fs.closeSync(fdOut); } catch (e) {}
        try { fs.closeSync(fdErr); } catch (e) {}
        let stdout = '', stderr = '';
        try { stdout = fs.readFileSync(outFile, 'utf8'); } catch (e) {}
        try { stderr = fs.readFileSync(errFile, 'utf8'); } catch (e) {}
        try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) {}
        resolve({ code: typeof code === 'number' ? code : 1, stdout: stdout, stderr: stderr, error: null });
      });
    } catch (error) {
      if (fdOut != null) { try { fs.closeSync(fdOut); } catch (e) {} }
      if (fdErr != null) { try { fs.closeSync(fdErr); } catch (e) {} }
      if (scratch) { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) {} }
      resolve({ code: 1, stdout: '', stderr: '', error: String((error && error.message) || error) });
    }
  });
}

function parseSmokeSummary(text) {
  const body = String(text || '');
  const m = body.match(/包件|套件\s*(\d+)\s*·\s*断言\s*(\d+)[^\n]*?断言失败\s*(\d+)[^\n]*?失败套件\s*(\d+)/);
  if (m) return { suites: Number(m[1]), assertions: Number(m[2]), failed_assertions: Number(m[3]), failed_suites: Number(m[4]) };
  const alt = body.match(/PASS\s+(\d+)\s+FAIL\s+(\d+)/);
  if (alt) return { suites: null, assertions: Number(alt[1]) + Number(alt[2]), failed_assertions: Number(alt[2]), failed_suites: Number(alt[2]) > 0 ? 1 : 0 };
  return null;
}

export async function runReleaseCheck(options) {
  const o = options || {};
  const exec = typeof o.exec === 'function' ? o.exec : fileExec;
  const root = path.resolve(o.root || path.resolve(S.BUS_DIR, '..'));
  const cli = path.join(S.BUS_DIR, 'cli.mjs');
  const smokeAll = path.join(S.BUS_DIR, 'smoke-all.mjs');
  const steps = [];

  const pack = inspectPack({ root: root });
  steps.push({ id: 'pack_inspection', title: '打包清单（package.json files 白名单）', status: pack.ok ? 'ok' : 'fail',
    detail: pack.files.length + ' 个文件 / ' + pack.total_bytes + ' 字节' + (pack.violations.length ? '；命中敏感项: ' + pack.violations.map(function (v) { return v.path; }).join(', ') : '；未命中任何敏感项'),
    fix: pack.ok ? null : '从 package.json 的 files 白名单里移除这些路径，或把它们加进 .npmignore' });

  // 发布检查要验证「全新安装后是否健康」，而不是「这台机器初始化过没有」。
  // 空 runner 上 bus/bus.db 本来就不存在，用真实 HOME 跑 doctor 必然 FAIL（CI 上就卡在这）。
  const releaseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-release-'));
  const releaseEnv = { HOME: releaseHome, USERPROFILE: releaseHome, BUS_DB: path.join(releaseHome, 'bus.db'), BUS_PROJECTS: path.join(releaseHome, 'projects.json') };
  const initRun = await exec(process.execPath, [cli, 'init'], { cwd: root, env: releaseEnv });
  const initOk = Number(initRun && initRun.code) === 0;
  const doctorRun = await exec(process.execPath, [cli, 'doctor', '--json'], { cwd: root, env: releaseEnv });
  let doctorReport = null;
  try { doctorReport = JSON.parse(String(doctorRun.stdout || '').slice(String(doctorRun.stdout || '').indexOf('{'))); } catch (e) { doctorReport = null; }
  const doctorOk = initOk && !!doctorReport && Number(doctorReport.counts && doctorReport.counts.fail) === 0;
  // 只报计数等于让人去猜哪一项红了（CI 上就是这样被卡住一轮）：把失败项的名字与修复命令直接打出来。
  const failingChecks = doctorReport && Array.isArray(doctorReport.checks) ? doctorReport.checks.filter(function (c) { return c.status === 'fail'; }) : [];
  const doctorDetail = doctorReport
    ? ('ok=' + doctorReport.counts.ok + ' warn=' + doctorReport.counts.warn + ' fail=' + doctorReport.counts.fail
       + (failingChecks.length ? '；失败项: ' + failingChecks.map(function (c) { return c.title + ' — ' + String(c.detail || '').slice(0, 200); }).join(' | ') : ''))
    : ('无法解析 doctor 输出: ' + String((doctorRun.stderr || doctorRun.error || '').slice(0, 200)));
  steps.push({ id: 'doctor', title: 'agentbus doctor --json', status: doctorOk ? (Number(doctorReport.counts.warn) > 0 ? 'warn' : 'ok') : 'fail',
    detail: (initOk ? '' : 'agentbus init 失败（全新安装不可用）: ' + String((initRun.stderr || initRun.error || '').slice(0, 200)) + '；') + doctorDetail + '（在临时 HOME 里先 init 再诊断）',
    fix: doctorOk ? null : (failingChecks.length ? failingChecks.map(function (c) { return c.fix; }).filter(Boolean).join(' / ') : '按 agentbus doctor 的修复命令逐项处理后再发布') });

  if (o.skipSmoke === true) {
    steps.push({ id: 'smoke', title: '全量 smoke', status: 'skip', detail: '按 --skip-smoke 跳过', fix: null });
  } else {
    const smokeRun = await exec(process.execPath, [smokeAll], { cwd: root });
    const summary = parseSmokeSummary(smokeRun.stdout);
    const smokeOk = !!summary && summary.failed_suites === 0 && summary.failed_assertions === 0;
    steps.push({ id: 'smoke', title: '全量 smoke（smoke-all）', status: smokeOk ? 'ok' : (summary ? 'fail' : 'skip'),
      detail: summary ? ('套件 ' + summary.suites + ' · 断言 ' + summary.assertions + ' · 断言失败 ' + summary.failed_assertions + ' · 失败套件 ' + summary.failed_suites)
        : ('smoke-all 没有给出可解析的汇总（退出码 ' + smokeRun.code + '，' + String((smokeRun.stderr || smokeRun.error || '').slice(0, 160)) + '）'),
      fix: smokeOk ? null : '先修 smoke 再发布；本机受限时用 --skip-smoke 并在 PR 里附上 CI 结果' });
  }

  const npmRun = await exec('npm', ['pack', '--dry-run', '--json'], { cwd: root });
  let npmPack = null;
  try { npmPack = JSON.parse(String(npmRun.stdout || '')); } catch (e) { npmPack = null; }
  if (!npmPack) {
    steps.push({ id: 'npm_pack', title: 'npm pack --dry-run', status: 'skip',
      detail: '本机没有可用的 npm 或输出无法解析：' + String((npmRun.error || npmRun.stderr || '').slice(0, 160)), fix: null });
  } else {
    const entry = Array.isArray(npmPack) ? npmPack[0] : npmPack;
    const listed = ((entry && entry.files) || []).map(function (f) { return f.path; });
    const bad = [];
    for (const p of listed) for (const rule of SENSITIVE_PATTERNS) if (rule.re.test(p)) bad.push({ path: p, why: rule.why });
    steps.push({ id: 'npm_pack', title: 'npm pack --dry-run', status: bad.length ? 'fail' : 'ok',
      detail: listed.length + ' 个文件' + (bad.length ? '；命中敏感项: ' + bad.map(function (b) { return b.path; }).join(', ') : '；未命中敏感项'),
      fix: bad.length ? '从 files 白名单移除或加 .npmignore' : null });
  }

  const counts = { ok: 0, warn: 0, skip: 0, fail: 0 };
  for (const step of steps) counts[step.status] = (counts[step.status] || 0) + 1;
  // 临时 HOME 用完即删：发布检查不该在临时目录里留运行数据。
  try { fs.rmSync(releaseHome, { recursive: true, force: true }); } catch (e) {}
  return { ok: counts.fail === 0, version: pack.version, root: root, steps: steps, counts: counts, pack: { files: pack.files.length, bytes: pack.total_bytes, violations: pack.violations } };
}
