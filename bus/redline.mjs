// 红线识别：把命令文本或路径翻译成"需要人类批准"的 kinds。
export const KINDS = ['dep:install', 'fs:delete', 'git:risky', 'cfg:edit', 'net:egress'];

// 文本规则：输入统一转小写，正则按小写书写；词边界防止 npm i 误伤 npm init。
const TEXT_RULES = [
  ['dep:install', [
    /\bnpm\s+(?:i|ci|install|add|update)\b/,
    /\bpnpm\s+(?:i|install|add|update)\b/,
    /\byarn\s+(?:add|install|upgrade)\b/,
    /\bpip3?\s+install\b/,
    /\bpython[0-9.]*\s+-m\s+pip\s+install\b/,
    /\bcargo\s+add\b/,
    /\bgo\s+get\b/,
    /\bwinget\s+install\b/,
    /\bchoco\s+install\b/,
    /\bdotnet\s+add\s+package\b/,
    /\bapt(?:-get)?\s+install\b/,
    /\bbrew\s+install\b/,
  ]],
  ['fs:delete', [
    /\brm\s+-[a-z]*[rf]/,
    /\brmdir\b/,
    /\bremove-item\b/,
    /\bdel\s+\/[fsq]/,
    /\brd\s+\/s\b/,
    /\bshutil\.rmtree\b/,
    /\bgit\s+clean\s+-/,
    /\bgit\s+rm\b/,
  ]],
  ['git:risky', [
    /\bgit\s+push\b/,
    /\bgit\s+reset\s+--hard\b/,
    /--force-with-lease\b/,
    /\bgit\s+rebase\b/,
    /\bgit\s+filter-branch\b/,
    /\bgit\s+checkout\s+--\s+\./,
    /\bgit\s+restore\s+--source\b/,
    /\bgit\s+branch\s+-d\b/,
  ]],
  ['net:egress', [
    /\bcurl\b/,
    /\bwget\b/,
    /\binvoke-webrequest\b/,
    /\binvoke-restmethod\b/,
    /\bscp\b/,
  ]],
];

// 命中这些文件名说明有人在改"谁能批什么"，一律需要人类点头
const CFG_NEEDLES = ['rules.md', 'policy.json', 'projects.json', 'schema.sql'];

export function classifyText(text) {
  if (text == null) return [];
  const s = String(text).toLowerCase();
  if (!s) return [];
  const hit = [];
  for (const rule of TEXT_RULES) {
    if (rule[1].some(function (re) { return re.test(s); })) hit.push(rule[0]);
  }
  return hit;
}

export function classifyPaths(paths) {
  const list = Array.isArray(paths) ? paths : (paths == null ? [] : [paths]);
  const s = list.filter(Boolean).map(function (p) { return String(p).toLowerCase().replace(/\\/g, '/'); }).join('\n');
  if (!s) return [];
  return CFG_NEEDLES.some(function (n) { return s.indexOf(n) >= 0; }) ? ['cfg:edit'] : [];
}

function collect(v, out) {
  if (v == null) return;
  if (Array.isArray(v)) { for (const x of v) collect(x, out); return; }
  if (typeof v !== 'string') return;
  const s = v.trim();
  if (!s) return;
  if (s.charAt(0) === '[') {
    try { collect(JSON.parse(s), out); return; } catch (e) {}
  }
  out.push(s);
}

export function mergeKinds() {
  const all = [];
  for (let i = 0; i < arguments.length; i++) collect(arguments[i], all);
  const seen = new Set();
  const out = [];
  for (const k of all) {
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

// 缺配置时按最严处理：任何 kind 都视作人类专属
export function isHumanOnly(kinds, policy) {
  const list = mergeKinds(kinds);
  if (!list.length) return false;
  const cfg = policy && policy.redline && policy.redline.human_only ? policy.redline.human_only : KINDS;
  const human = mergeKinds(cfg);
  return list.some(function (k) { return human.indexOf(k) >= 0; });
}
