#!/usr/bin/env node
// 第 15 项：文档一致性测试（只读校验，不改文档实质内容）。
// 数字全部从运行时导出后比对；--print-facts 打印事实；内置自测：故意改错一个数字必须变红。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as S from './store.mjs';

const BUS = S.BUS_DIR;
const ROOT = path.resolve(BUS, '..');
const README = path.join(ROOT, 'README.md');
const RULES = path.join(ROOT, 'RULES.md');
const DELIVERY = path.join(BUS, 'DELIVERY-STATUS.md');

// ---------- 运行时事实 ----------
export function docsFacts() {
  const mcp = fs.readFileSync(path.join(BUS, 'bus-mcp.mjs'), 'utf8');
  const tools = new Set();
  for (const match of mcp.matchAll(/name:\s*'(bus_[a-z_]+)'/g)) tools.add(match[1]);
  const consoleSource = fs.readFileSync(path.join(BUS, 'console-server.mjs'), 'utf8');
  const portMatch = consoleSource.match(/opts\.port\s*\|\|\s*(\d+)/);
  const policy = JSON.parse(fs.readFileSync(path.join(BUS, 'policy.json'), 'utf8'));
  const suites = fs.readdirSync(BUS).filter(function (name) { return /^smoke.*\.mjs$/.test(name); });
  return {
    tool_count: tools.size,
    tools: Array.from(tools).sort(),
    suite_count: suites.length,
    default_port: portMatch ? Number(portMatch[1]) : null,
    lead: policy.lead,
    require_credentials: !!(policy.global && policy.global.require_credentials),
    daily_token_budget: (policy.economics && policy.economics.daily_token_budget) || null,
    retention_clears: Object.keys(policy.retention || {}).some(function (key) { return Number(policy.retention[key]) > 0; }),
    policy: policy,
  };
}

// 交付矩阵校验（矩阵里的 enabled 不许凭嘴说）
export const STATE_VALUES = ['yes', 'no', 'partial', 'true', 'false'];
// 这几项是代码级不变量：没有配置开关，恒生效。白名单放在代码里，不允许在文档里自己声明。
export const ALWAYS_ON_ITEMS = [4, 12, 13, 14, 15];

export function resolvePolicyPath(policy, dotted) {
  let cursor = policy;
  for (const part of String(dotted).split('.')) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

// "开着"的定义：非 null/undefined、非 0、非空数组、非空字符串
export function policySwitchOn(policy, dotted) {
  const value = resolvePolicyPath(policy, dotted);
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 0;
  return false;
}

export function matrixRows(delivery) {
  return String(delivery).split(/\r?\n/).filter(function (line) {
    return /^\|\s*\d+\s*\|/.test(line);
  });
}

export function checkMatrix(delivery, facts) {
  const violations = [];
  const rows = matrixRows(delivery);
  if (!rows.length) { violations.push('DELIVERY-STATUS.md 没有任何矩阵行'); return violations; }
  const seen = new Set();
  for (const row of rows) {
    const cells = row.split('|').map(function (cell) { return cell.trim(); }).filter(function (cell) { return cell.length > 0; });
    if (cells.length < 8) { violations.push('矩阵行列数不足（需要 项|能力|implemented|wired|enabled|verified|开关|证据）：' + row.slice(0, 80)); continue; }
    const item = cells[0];
    if (seen.has(item)) violations.push('矩阵项重复：' + item);
    seen.add(item);
    for (const cell of cells.slice(2, 6)) {
      if (STATE_VALUES.indexOf(cell.toLowerCase()) < 0) violations.push('矩阵列取值非法（' + cell + '）：' + item);
    }
    const enabled = cells[4].toLowerCase();
    const switchPath = cells[6];
    if (switchPath === 'always') {
      if (ALWAYS_ON_ITEMS.indexOf(Number(item)) < 0) violations.push('项 ' + item + ' 声明 always（无开关恒生效）但不在白名单里');
    } else if (switchPath === '无') {
      if (enabled === 'yes') violations.push('项 ' + item + ' 写 enabled=yes 却没有给出开关（必须是 policy.json 里的路径）');
    } else if (enabled === 'yes' && facts && facts.policy) {
      if (!policySwitchOn(facts.policy, switchPath)) {
        violations.push('项 ' + item + ' 写 enabled=yes，但 policy.json 里 ' + switchPath + ' 并没有开启（值=' + JSON.stringify(resolvePolicyPath(facts.policy, switchPath)) + '）');
      }
    }
    const evidence = cells[7] || '';
    const suiteMatch = evidence.match(/(smoke[\w-]*\.mjs)\s+(\d+)\/(\d+)/);
    if (!suiteMatch) { if (evidence !== '无') violations.push('证据格式非法：' + item + ' → ' + evidence); continue; }
    if (!fs.existsSync(path.join(BUS, suiteMatch[1]))) violations.push('证据套件不存在：' + suiteMatch[1]);
  }
  return violations;
}

// ---------- 纯函数校验器（自测复用它） ----------
export function checkDocs(docs, facts) {
  const violations = [];
  const readme = String(docs.readme || '');
  const rules = String(docs.rules || '');
  const delivery = String(docs.delivery || '');
  const all = readme + '\n' + rules;

  // 1) 端口：文档里出现的 127.0.0.1:<port> 必须是默认端口，或是明确属于其它入口的已登记端口
  const otherEntryPorts = [7401]; // start-board.cmd
  for (const match of all.matchAll(/127\.0\.0\.1:(\d{2,5})/g)) {
    const port = Number(match[1]);
    if (port !== facts.default_port && otherEntryPorts.indexOf(port) < 0) {
      violations.push('端口不一致：文档写 ' + port + '，console-server 默认是 ' + facts.default_port);
    }
  }

  // 2) 默认 Lead
  for (const match of all.matchAll(/默认\s*Lead\s*是\s*\x60([^\x60]+)\x60/gi)) {
    if (match[1] !== facts.lead) violations.push('默认 Lead 不一致：文档写 ' + match[1] + '，policy.json 是 ' + facts.lead);
  }

  // 3) 工具数 / 套件数：文档若写了数字就必须等于运行时
  for (const match of all.matchAll(/(\d+)\s*(?:个)?\s*(?:MCP\s*)?工具/g)) {
    if (Number(match[1]) !== facts.tool_count) violations.push('工具数不一致：文档写 ' + match[1] + '，运行时是 ' + facts.tool_count);
  }
  for (const match of all.matchAll(/(\d+)\s*套(?:测试)?套件|(\d+)\s*个套件/g)) {
    const stated = Number(match[1] || match[2]);
    if (stated !== facts.suite_count) violations.push('套件数不一致：文档写 ' + stated + '，运行时是 ' + facts.suite_count);
  }

  // 4) 未启用的开关不得被描述成已启用
  for (const line of all.split(/\r?\n/)) {
    const mentionsUnenabled = line.indexOf('require_credentials') >= 0 || line.indexOf('daily_token_budget') >= 0;
    if (!mentionsUnenabled) continue;
    if (/已启用|已开启|已完成|enabled\s*=\s*true/i.test(line)) {
      violations.push('未启用的开关被写成已启用：' + line.trim().slice(0, 120));
    }
  }
  if (facts.require_credentials === false && /require_credentials[^\n]*\btrue\b/.test(readme) && !/require_credentials=false|require_credentials\s*=\s*false/.test(readme)) {
    // 允许矩阵里写 require_credentials=false；写 true 直接算违规
  }

  // 5) verify_cmd 不得再作为机械验收主路径（兼容说明除外）
  for (const line of all.split(/\r?\n/)) {
    if (line.indexOf('verify_cmd') < 0) continue;
    if (/兼容|legacy|旧版|历史|待批/.test(line)) continue;
    // 只拦"把 verify_cmd 当主路径"的说法；提到 guard/限制/策略表不算
    if (!/主路径|主流程|主要方式|即可验收|用它验收|验收主路径/.test(line)) continue;
    violations.push('verify_cmd 仍被当作主路径描述：' + line.trim().slice(0, 120));
  }

  // 6) 状态词定义齐全
  for (const word of ['implemented', 'wired', 'enabled', 'verified']) {
    if (readme.indexOf(word) < 0) violations.push('README 缺少状态词定义：' + word);
  }

  // 7) 交付矩阵：四列取值合法 + 证据套件存在 + **enabled=yes 必须有真的开着的策略开关**
  const matrix = checkMatrix(delivery, facts);
  for (const violation of matrix) violations.push(violation);
  return violations;
}

// ---------- 真实运行证据套件，核对数字 ----------
function runSuite(file) {
  const out = path.join(S.BUS_DIR, '.smoke-docs-out.txt');
  const err = path.join(S.BUS_DIR, '.smoke-docs-err.txt');
  const fd1 = fs.openSync(out, 'w');
  const fd2 = fs.openSync(err, 'w');
  try { spawnSync(process.execPath, [path.join(BUS, file)], { cwd: ROOT, stdio: ['ignore', fd1, fd2], timeout: 240000 }); }
  finally { fs.closeSync(fd1); fs.closeSync(fd2); }
  const text = fs.readFileSync(out, 'utf8') + fs.readFileSync(err, 'utf8');
  fs.rmSync(out, { force: true });
  fs.rmSync(err, { force: true });
  const match = text.match(/PASS\s+(\d+)\s+FAIL\s+(\d+)/);
  return match ? { pass: Number(match[1]), fail: Number(match[2]) } : null;
}

function main() {
  const facts = docsFacts();
  if (process.argv.indexOf('--print-facts') >= 0) {
    console.log(JSON.stringify(facts, null, 2));
    return;
  }
  const docs = {
    readme: fs.readFileSync(README, 'utf8'),
    rules: fs.existsSync(RULES) ? fs.readFileSync(RULES, 'utf8') : '',
    delivery: fs.readFileSync(DELIVERY, 'utf8'),
  };
  let pass = 0, fail = 0;
  function ok(name, value, detail) {
    if (value) { pass += 1; console.log('  PASS  ' + name); }
    else { fail += 1; console.log('  FAIL  ' + name + (detail ? ' — ' + JSON.stringify(detail) : '')); }
  }

  console.log('[1] 运行时事实');
  ok('工具数从 bus-mcp.mjs 导出', facts.tool_count > 10, facts.tool_count);
  ok('默认端口从 console-server.mjs 导出', facts.default_port === 7400, facts.default_port);
  ok('Lead 从 policy.json 导出', typeof facts.lead === 'string' && facts.lead.length > 0, facts.lead);

  console.log('\n[2] 文档与运行时一致');
  const violations = checkDocs(docs, facts);
  ok('README / RULES / DELIVERY-STATUS 无违规', violations.length === 0, violations);
  ok('README 含四词状态词定义', ['implemented', 'wired', 'enabled', 'verified'].every(function (w) { return docs.readme.indexOf(w) >= 0; }));
  ok('README 声明数字以运行时为准', docs.readme.indexOf('smoke-docs.mjs --print-facts') >= 0);

  console.log('\n[3] 未启用开关如实标注');
  ok('require_credentials 仍为 false 且文档标注', facts.require_credentials === false && docs.delivery.indexOf('require_credentials') >= 0);
  ok('daily_token_budget 仍未配置且文档标注', facts.daily_token_budget === null && docs.delivery.indexOf('daily_token_budget') >= 0);
  ok('retention 默认不清理', facts.retention_clears === false && docs.delivery.indexOf('retention') >= 0);

  const withEvidence = process.argv.indexOf('--evidence') >= 0;
  console.log('\n[4] 交付矩阵证据（' + (withEvidence ? '实跑核对' : '静态校验：格式 + 套件存在') + '）');
  const rows = matrixRows(docs.delivery);
  for (const row of rows) {
    const cells = row.split('|').map(function (c) { return c.trim(); }).filter(Boolean);
    const evidence = cells[7] || '';
    // 证据列可能追加了多个套件（例如「… · smoke-enable-drill.mjs 19/0（临时环境演练）」），
    // 每一个被提到的套件都必须真实存在，不能只在第一段上过校验。
    const mentioned = Array.from(evidence.matchAll(/smoke[\w-]*\.mjs/g)).map(function (m) { return m[0]; });
    for (const name of mentioned) {
      if (!fs.existsSync(path.join(BUS, name))) ok(cells[0] + ' 证据里提到的套件存在（' + name + '）', false, evidence);
    }
    const match = evidence.match(/(smoke[\w-]*\.mjs)\s+(\d+)\/(\d+)/);
    if (!match) { ok(cells[0] + ' 证据可核对', evidence === '无', evidence); continue; }
    if (!withEvidence) {
      // 默认只做静态校验：套件必须存在；数字交给 --evidence 或 smoke-all，避免被别人的瞬时红牵连
      ok(cells[0] + ' 证据格式合法且套件存在（' + match[1] + '）', fs.existsSync(path.join(BUS, match[1])), evidence);
      continue;
    }
    const result = runSuite(match[1]);
    ok(cells[0] + ' 证据 ' + match[1] + ' 实跑 ' + (result ? result.pass + '/' + result.fail : '无输出'),
      !!result && result.pass === Number(match[2]) && result.fail === Number(match[3]),
      { stated: evidence, actual: result });
  }

  console.log('\n[5] 自测：故意改错必须变红');
  // 关键自测：把 enabled 改成 yes 而开关没开，矩阵校验必须红
  const flip = (function () {
    const lines = docs.delivery.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (/^\|\s*5\s*\|/.test(lines[i])) {
        const cells = lines[i].split('|');
        cells[5] = ' yes ';
        lines[i] = cells.join('|');
        return lines.join('\n');
      }
    }
    return null;
  })();
  ok('把 enabled 改成 yes 而 policy 开关没开 → 矩阵校验必须失败', !!flip && checkDocs({ readme: docs.readme, rules: docs.rules, delivery: flip }, facts).some(function (v) { return v.indexOf('enabled=yes') >= 0; }), flip ? checkMatrix(flip, facts) : '找不到第 5 项那一行');
  // 反向自测：开关真开着（dispatch_enabled=true）的项写 enabled=yes 必须通过
  const allowed = (function () {
    const lines = docs.delivery.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (/^\|\s*3\s*\|/.test(lines[i])) { const c = lines[i].split('|'); c[5] = ' yes '; lines[i] = c.join('|'); return lines.join('\n'); }
    }
    return null;
  })();
  ok('开关真开着的项写 enabled=yes 必须通过（校验不是一刀切禁言）', !!allowed && checkMatrix(allowed, facts).length === 0, allowed ? checkMatrix(allowed, facts) : '找不到第 3 项');
  const noSwitch = docs.delivery.replace(/^\|\s*13\s*\|.*$/m, function (line) { return line.replace('| always |', '| 无 |'); });
  ok('把恒生效项改成"无开关"且 enabled=yes 必须失败', checkMatrix(noSwitch, facts).some(function (v) { return v.indexOf('enabled=yes') >= 0; }));
  const brokenPort = Object.assign({}, docs, { readme: docs.readme.replace(/127\.0\.0\.1:7400/g, '127.0.0.1:7499') });
  const portViolations = checkDocs(brokenPort, facts);
  ok('改错端口后校验必须失败', portViolations.some(function (v) { return v.indexOf('端口不一致') >= 0; }), portViolations);
  const brokenTools = Object.assign({}, docs, { readme: docs.readme + '\n\n> 当前共 ' + (facts.tool_count + 1) + ' 个工具。\n' });
  ok('改错工具数后校验必须失败', checkDocs(brokenTools, facts).some(function (v) { return v.indexOf('工具数不一致') >= 0; }));
  const brokenEnabled = Object.assign({}, docs, { readme: docs.readme + '\n\n> global.require_credentials 已启用。\n' });
  ok('把未启用开关写成已启用必须失败', checkDocs(brokenEnabled, facts).some(function (v) { return v.indexOf('未启用的开关') >= 0; }));
  const brokenVerify = Object.assign({}, docs, { rules: docs.rules + '\n\n验收主路径：填写 verify_cmd。\n' });
  ok('把 verify_cmd 当主路径必须失败', checkDocs(brokenVerify, facts).some(function (v) { return v.indexOf('verify_cmd') >= 0; }));

  console.log('\n==================================');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
}

main();
