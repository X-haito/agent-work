#!/usr/bin/env node
// 唯一回归入口：发现并运行 bus/smoke*.mjs，给出可信的全量统计。
//   node bus/smoke-all.mjs               人读汇总
//   node bus/smoke-all.mjs --json        机器读汇总（stdout 只有 JSON）
//   node bus/smoke-all.mjs --strict      SKIP 也算失败（CI 合并门禁用）
//   node bus/smoke-all.mjs --timeout 180 单套件超时（秒，默认 120）
//
// 三个刻意的设计：
// 1) 不写死清单：glob 发现 smoke*.mjs（排除自己），顺序按名字排序保证稳定。
// 2) 子进程不用管道 stdio，而是把 stdout/stderr 重定向到临时文件再读回来：
//    受限沙箱里管道 spawn 会被拒绝（EPERM），用文件重定向既能跑、又不会死锁。
// 3) 需要管道/端口的套件跑不起来时记为 SKIP + reason，绝不写成 PASS，也不整体挂死。
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(BUS_DIR, '..');
const SELF = path.basename(fileURLToPath(import.meta.url));

function argValue(name, fallback) {
  const eq = process.argv.find(function (a) { return a.indexOf('--' + name + '=') === 0; });
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1] && process.argv[i + 1].slice(0, 2) !== '--') return process.argv[i + 1];
  return fallback;
}
import { decide, CI_REQUIRED_SUITES, normalizeSuiteName } from './smoke-support/summary.mjs';

const JSON_MODE = process.argv.indexOf('--json') >= 0;
const STRICT = process.argv.indexOf('--strict') >= 0;
// 第 11 项第 3 条：必需套件在 CI 里被 SKIP 等于失败。--profile ci 用 CI 必需清单，
// 也可以用 --require smoke-e2e,smoke-auth 显式指定。
const PROFILE = argValue('profile', '');
const REQUIRED = (function () {
  if (PROFILE === 'ci') return CI_REQUIRED_SUITES.slice();
  const raw = argValue('require', '');
  return raw ? raw.split(',').map(function (x) { return x.trim(); }).filter(Boolean) : [];
})();
const TIMEOUT_MS = Math.max(1, Number(argValue('timeout', 120)) || 120) * 1000;

// 子进程的隔离环境：独立 HOME/USERPROFILE、独立 DB/registry 路径，并清掉调用者的身份，
// 免得某个套件读到本进程的凭据或配置。绝大多数套件本来就自己建临时库。
function suiteEnv(dir) {
  const env = Object.assign({}, process.env);
  env.HOME = dir;
  env.USERPROFILE = dir;
  env.BUS_DB = path.join(dir, 'bus.db');
  env.BUS_PROJECTS = path.join(dir, 'projects.json');
  // HOME 换了以后 git 读不到 ~/.gitconfig：用环境变量给一个身份，否则依赖 git commit/merge 的套件会假失败。
  env.GIT_AUTHOR_NAME = 'smoke-all';
  env.GIT_AUTHOR_EMAIL = 'smoke-all@localhost';
  env.GIT_COMMITTER_NAME = 'smoke-all';
  env.GIT_COMMITTER_EMAIL = 'smoke-all@localhost';
  delete env.AGENT_BUS_TOKEN;
  delete env.AGENT_BUS_ID;
  return env;
}

// 两种输出格式：'PASS n   FAIL m' 与 'smoke-routing: n passed'
function parseCounts(text) {
  const body = String(text || '');
  let pass = null, fail = null;
  const summary = body.match(/PASS\s+(\d+)\s+FAIL\s+(\d+)/gi);
  if (summary && summary.length) {
    const last = summary[summary.length - 1].match(/PASS\s+(\d+)\s+FAIL\s+(\d+)/i);
    pass = Number(last[1]); fail = Number(last[2]);
  }
  const alt = body.match(/smoke-routing:\s*(\d+)\s+passed/i);
  if (alt) { pass = (pass == null ? 0 : pass) + Number(alt[1]); fail = (fail == null ? 0 : fail); }
  return { pass: pass, fail: fail };
}

function looksLikeEperm(text) {
  return /spawn EPERM|code:\s*'EPERM'|EPERM/.test(String(text || ''));
}

function runSuite(file) {
  const name = path.basename(file);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-all-' + name.replace(/[^a-z0-9]+/gi, '-') + '-'));
  const outFile = path.join(dir, 'stdout.txt');
  const errFile = path.join(dir, 'stderr.txt');
  const started = Date.now();
  return new Promise(function (resolve) {
    let fdOut = null, fdErr = null, child = null;
    let settled = false;
    function finish(code, failureReason) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let stdout = '', stderr = '';
      try { if (fdOut != null) { fs.closeSync(fdOut); fdOut = null; } } catch (e) {}
      try { if (fdErr != null) { fs.closeSync(fdErr); fdErr = null; } } catch (e) {}
      try { stdout = fs.readFileSync(outFile, 'utf8'); } catch (e) {}
      try { stderr = fs.readFileSync(errFile, 'utf8'); } catch (e) {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
      const duration = Date.now() - started;
      const combined = stdout + '\n' + stderr;
      const counts = parseCounts(combined);
      let status = 'passed';
      let reason = null;
      if (failureReason) { status = failureReason; }
      else if (looksLikeEperm(combined) && (counts.pass == null || code !== 0)) {
        // 套件内部的子进程被沙箱拒绝：记 SKIP，绝不记 PASS。
        status = 'skipped'; reason = 'spawn_eperm';
      } else if (code !== 0) { status = 'failed'; }
      if (status === 'passed' && (counts.pass == null || counts.fail > 0)) {
        status = counts.pass == null ? 'unparsed' : 'failed';
        reason = counts.pass == null ? 'no_parseable_summary' : 'assertions_failed';
      }
      resolve({ name: name, pass: counts.pass == null ? 0 : counts.pass, fail: counts.fail == null ? 0 : counts.fail,
        status: status, reason: reason, exit_code: code == null ? null : code, duration_ms: duration,
        // 失败详情保留尾部 2000 字符：套件的真正错误几乎总在最后（之前的 400 字符+压缩空白
        // 会把 FAIL 行和异常栈切掉，CI 日志里只剩「exit code 1」）。
        detail: status === 'passed' ? null : (combined.replace(/\s+/g, ' ').trim().slice(-2000) || null),
        detail_tail: status === 'passed' ? null : combined.split('\n').slice(-25).join('\n') });
    }
    // 超时要连子进程树一起收掉：套件自己可能开了 server/子进程，只 kill 自己会留孤儿。
    function killTree() {
      if (!child || !child.pid) return;
      try {
        if (process.platform === 'win32') cp.spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        else process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        try { child.kill('SIGKILL'); } catch (error2) {}
      }
    }
    const timer = setTimeout(function () { finish(null, 'timeout'); killTree(); }, TIMEOUT_MS);
    try {
      fdOut = fs.openSync(outFile, 'w');
      fdErr = fs.openSync(errFile, 'w');
      child = cp.spawn(process.execPath, [file], {
        cwd: ROOT, env: suiteEnv(dir), stdio: ['ignore', fdOut, fdErr], windowsHide: true, shell: false,
        detached: process.platform !== 'win32',   // 非 Windows 下开进程组，超时才能整棵树收掉
      });
      child.on('error', function (error) { finish(null, looksLikeEperm(String(error && error.message || error)) ? 'skipped' : 'failed'); });
      child.on('close', function (code) { finish(code, null); });
    } catch (error) {
      const message = String((error && error.message) || error);
      if (looksLikeEperm(message)) { settled = true; clearTimeout(timer); resolve({ name: name, pass: 0, fail: 0, status: 'skipped', reason: 'spawn_eperm', exit_code: null, duration_ms: Date.now() - started, detail: message.slice(0, 200) }); }
      else finish(null, 'failed');
    }
  });
}

function pad(text, width) {
  let value = String(text == null ? '' : text);
  let w = 0;
  for (const ch of value) w += ch.charCodeAt(0) > 127 ? 2 : 1;
  while (w < width) { value += ' '; w += 1; }
  return value;
}

async function main() {
  const suites = fs.readdirSync(BUS_DIR)
    .filter(function (n) { return /^smoke.*\.mjs$/.test(n) && n !== SELF; })
    .sort()
    .map(function (n) { return path.join(BUS_DIR, n); });
  if (!suites.length) {
    console.error('bus/ 下没有发现任何 smoke*.mjs');
    process.exitCode = 1;
    return;
  }
  if (!JSON_MODE) console.log('smoke-all: ' + suites.length + ' 个套件，单套件超时 ' + Math.round(TIMEOUT_MS / 1000) + 's' + (STRICT ? '（strict：SKIP 也算失败）' : ''));
  const results = [];
  const startedAll = Date.now();
  for (const file of suites) {
    const result = await runSuite(file);
    results.push(result);
    if (!JSON_MODE) {
      const tag = result.status === 'passed' ? 'PASS  ' : result.status === 'skipped' ? 'SKIP  ' : result.status === 'timeout' ? 'TIME  ' : 'FAIL  ';
      const extra = result.status === 'skipped' ? '（' + result.reason + '）' : result.status === 'passed' ? '' : '（' + (result.reason || result.status) + '）';
      console.log('  ' + tag + pad(result.pass + '/' + result.fail, 9) + pad(result.name, 30) + result.duration_ms + 'ms' + extra);
    }
  }
  const totalPass = results.reduce(function (n, r) { return n + r.pass; }, 0);
  const totalFail = results.reduce(function (n, r) { return n + r.fail; }, 0);
  const failed = results.filter(function (r) { return r.status === 'failed' || r.status === 'timeout' || r.status === 'unparsed'; });
  const skipped = results.filter(function (r) { return r.status === 'skipped'; });
  const durationMs = Date.now() - startedAll;
  // 判定只在一处：bus/smoke-support/summary.mjs（本文件只负责跑与打印）。
  const decision = decide(results, { strict: STRICT, require: REQUIRED });
  const summary = {
    suites: results.map(function (r) { return { name: r.name.replace(/\.mjs$/, ''), pass: r.pass, fail: r.fail, status: r.status, reason: r.reason, duration_ms: r.duration_ms }; }),
    total_pass: totalPass, total_fail: totalFail, assertions: totalPass + totalFail,
    failed: failed.map(function (r) { return { name: r.name.replace(/\.mjs$/, ''), reason: r.reason || r.status, detail: r.detail }; }),
    skipped: skipped.map(function (r) { return { name: r.name.replace(/\.mjs$/, ''), reason: r.reason }; }),
    required: REQUIRED.map(normalizeSuiteName), required_skips: decision.required_skips,
    decision_ok: decision.ok, decision_reasons: decision.reasons, profile: PROFILE || null,
    suite_count: results.length, duration_ms: durationMs, strict: STRICT, timeout_ms: TIMEOUT_MS,
  };
  if (JSON_MODE) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    console.log('');
    console.log('套件 ' + results.length + ' · 断言 ' + summary.assertions + ' · 断言失败 ' + totalFail + ' · 失败套件 ' + failed.length +
      ' · 跳过 ' + skipped.length + ' · 用时 ' + (durationMs / 1000).toFixed(1) + 's');
    if (skipped.length) console.log('跳过: ' + skipped.map(function (r) { return r.name + '（' + r.reason + '）'; }).join(', '));
    if (REQUIRED.length) console.log('必需套件: ' + REQUIRED.join(', ') + (PROFILE ? '（profile=' + PROFILE + '）' : ''));
    if (decision.required_skips.length) console.log('必需套件被 SKIP（视为失败）: ' + decision.required_skips.join(', '));
    if (failed.length) {
      console.log('失败套件:');
      for (const r of failed) {
        console.log('  - ' + r.name + '（' + (r.reason || r.status) + '）');
        // CI 日志里必须能直接看到失败原因：打印尾部若干行，而不是压缩后截断。
        const tail = r.detail_tail || r.detail || '';
        if (tail) console.log(tail.split('\n').map(function (line) { return '      | ' + line; }).join('\n'));
      }
    }
  }
  if (!decision.ok) process.exitCode = 1;
}

main().catch(function (error) {
  process.stderr.write('smoke-all 崩了: ' + String((error && error.stack) || error) + '\n');
  process.exit(1);
});
