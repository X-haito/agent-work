import fs from 'node:fs';
import path from 'node:path';

function canonical(value) {
  try { return fs.realpathSync.native(value); }
  catch { return fs.realpathSync(value); }
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function noTraversal(value) {
  if (typeof value !== 'string' || !value || value.includes(String.fromCharCode(0)) || value.split(/[\\/]/).includes('..')) throw new Error('路径不能为空或包含 ..');
}

function realDirectory(value, allowLeaf) {
  try {
    const real = canonical(value);
    if (!fs.statSync(real).isDirectory()) throw new Error('授权根不是目录: ' + value);
    return real;
  } catch (error) {
    if (!allowLeaf || error.code !== 'ENOENT' || fs.existsSync(value)) throw error;
    // lstat catches dangling links; only a genuinely absent final component is allowed.
    try { fs.lstatSync(value); throw new Error('无法解析符号链接: ' + value); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (fs.readdirSync(path.dirname(value)).some(entry => process.platform === 'win32' ? entry.toLowerCase() === path.basename(value).toLowerCase() : entry === path.basename(value))) throw new Error('无法解析目录链接: ' + value);
    const parent = canonical(path.dirname(value));
    if (!fs.statSync(parent).isDirectory()) throw new Error('父路径不是目录');
    return path.join(parent, path.basename(value));
  }
}

export function normalizeRoots({ projectRoot, cwd, extraDirs = [] } = {}) {
  try {
    noTraversal(projectRoot);
    if (!path.isAbsolute(projectRoot)) throw new Error('projectRoot 必须为绝对路径');
    const root = realDirectory(projectRoot, false);
    if (!Array.isArray(extraDirs)) throw new Error('extraDirs 必须是数组');
    const roots = [];
    for (const [index, value] of [cwd, ...extraDirs].entries()) {
      noTraversal(value);
      const absolute = path.isAbsolute(value) ? path.normalize(value) : path.resolve(root, value);
      const real = realDirectory(absolute, true);
      if (index === 0 || !path.isAbsolute(value)) {
        if (!contained(root, absolute) || !contained(root, real)) throw new Error('工作区或相对路径符号链接逃逸项目根: ' + value);
      } else {
        const parent = canonical(path.dirname(absolute));
        if (!contained(parent, real)) throw new Error('额外目录符号链接逃逸: ' + value);
      }
      const key = process.platform === 'win32' ? real.toLowerCase() : real;
      if (!roots.some(existing => (process.platform === 'win32' ? existing.toLowerCase() : existing) === key)) roots.push(real);
    }
    return { ok: true, roots };
  } catch (error) { return { ok: false, reason: 'invalid_execution_roots', message: '执行授权路径无效: ' + error.message }; }
}
