import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BUS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ID = /^[a-z0-9._-]+$/;
function invalid(message) { const error = new Error(message); error.statusCode = 400; throw error; }
function inside(root, value) { const relative = path.relative(root, value); return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)); }
function canonical(value) { try { return fs.realpathSync.native(value); } catch { return fs.realpathSync(value); } }

export function validateValidators(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('validators 必须是对象');
  const normalized = {};
  if (Object.keys(input).length > 100) invalid('validators 最多 100 项');
  for (const [id, spec] of Object.entries(input)) {
    if (!ID.test(id) || id.length > 100 || id === '__proto__') invalid('验证器 id 仅允许 a-z、0-9、点、下划线、连字符');
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) invalid('验证器 ' + id + ' 必须是对象');
    if (typeof spec.command !== 'string' || !spec.command.trim() || spec.command.length > 1000 || !/^[a-zA-Z0-9_ .:/\\-]+$/.test(spec.command) || spec.command !== spec.command.trim()) invalid('验证器 command 必须是可执行文件名或路径，不能包含 shell 运算符');
    if (!Array.isArray(spec.args) || spec.args.length > 100 || spec.args.some(arg => typeof arg !== 'string' || arg.length > 4000 || arg.includes(String.fromCharCode(0)))) invalid('验证器 args 必须是最多 100 项的字符串数组');
    const cwd = spec.cwd === undefined ? '.' : spec.cwd;
    if (typeof cwd !== 'string' || !cwd || cwd.length > 500 || path.isAbsolute(cwd) || path.win32.isAbsolute(cwd) || /^[a-z]:/i.test(cwd) || cwd.split(/[\\/]/).includes('..') || cwd.includes(String.fromCharCode(0))) invalid('验证器 cwd 必须是项目根内的相对路径，不能包含 ..');
    const timeout = spec.timeout_ms === undefined ? 600000 : spec.timeout_ms;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600000) invalid('验证器 timeout_ms 必须是 1–600000 的整数');
    Object.defineProperty(normalized, id, { enumerable: true, configurable: true, writable: true, value: { command: spec.command, args: spec.args.slice(), cwd, timeout_ms: timeout } });
  }
  return normalized;
}

export function verifierHash(spec) {
  return crypto.createHash('sha256').update(JSON.stringify({ command:spec.command,args:spec.args,cwd:spec.cwd,timeout_ms:spec.timeout_ms })).digest('hex');
}

export function verifierCwd(spec, projectRoot) {
  const root = canonical(projectRoot);
  const cwd = canonical(path.resolve(root, spec.cwd));
  if (!inside(root, cwd) || !fs.statSync(cwd).isDirectory()) invalid('验证器 cwd 解析后必须位于项目根目录内');
  return cwd;
}

export function resolveValidator(projectRoot, id) {
  try {
    if (typeof id !== 'string' || !ID.test(id) || id.length > 100) return { ok:false,reason:'unknown_validator',message:'未知验证器 id: '+String(id) };
    const config = JSON.parse(fs.readFileSync(path.join(projectRoot, 'project.json'), 'utf8'));
    const validators = validateValidators(config.validators || {});
    if (!Object.prototype.hasOwnProperty.call(validators, id)) return { ok:false,reason:'unknown_validator',message:'项目未登记验证器: '+id };
    const spec = validators[id];
    verifierCwd(spec, projectRoot);
    return { ok:true,spec,hash:verifierHash(spec) };
  } catch (error) { return { ok:false,reason:'invalid_validator',message:'项目验证器配置无效: '+error.message }; }
}

export function validateFrozenVerifier(task, projectRoot) {
  try {
    if (!task.verify_id || !task.verify_spec_json || !task.verify_spec_hash) return { ok:false,reason:'invalid_verifier',message:'任务缺少冻结的项目验证器' };
    const spec = validateValidators({ [task.verify_id]: typeof task.verify_spec_json === 'string' ? JSON.parse(task.verify_spec_json) : task.verify_spec_json })[task.verify_id];
    const current = resolveValidator(projectRoot, task.verify_id);
    if (!current.ok || verifierHash(spec) !== task.verify_spec_hash || current.hash !== task.verify_spec_hash) return { ok:false,reason:'config_tampered',message:'验证器配置或冻结 hash 已变更' };
    verifierCwd(spec, projectRoot);
    return { ok:true,spec };
  } catch (error) { return { ok:false,reason:'config_tampered',message:'验证器配置被篡改: '+error.message }; }
}

function terminateTree(child) {
  if (process.platform === 'win32') {
    const killer = spawn(path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell:false,stdio:'ignore',windowsHide:true });
    killer.on('error', () => { try { child.kill(); } catch {} });
    killer.on('close', () => { try { child.kill(); } catch {} });
  } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }
}

export async function runVerifier(spec, opts = {}) {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const runId = crypto.randomUUID();
  const taskId = String(opts.task_id || 'unassigned');
  let result = { ok:false,exit_code:null,duration_ms:0,stdout_tail:'',stderr_tail:'',log_path:null };
  let cwd;
  try {
    if (!/^[a-zA-Z0-9._-]+$/.test(taskId)) invalid('task_id 无效');
    const normalized = validateValidators({ [opts.verify_id || 'validator']: spec })[opts.verify_id || 'validator'];
    if (!opts.projectRoot) invalid('projectRoot 必填');
    if (opts.verify_id || opts.verify_spec_hash) {
      const frozen = validateFrozenVerifier({ verify_id:opts.verify_id,verify_spec_json:normalized,verify_spec_hash:opts.verify_spec_hash }, opts.projectRoot);
      if (!frozen.ok) return persist({ ...result,reason:frozen.reason,stderr_tail:frozen.message });
    }
    spec = normalized;
    cwd = verifierCwd(spec, opts.projectRoot);
  } catch (error) { return persist({ ...result,reason:'invalid_verifier',stderr_tail:error.message }); }
  const logPath = path.posix.join('logs','verify',taskId,runId+'.log');
  const absoluteLog = path.join(opts.logRoot || BUS_DIR, ...logPath.split('/'));
  fs.mkdirSync(path.dirname(absoluteLog), {recursive:true});
  const stdoutFile = absoluteLog + '.stdout';
  const stderrFile = absoluteLog + '.stderr';
  const outFd = fs.openSync(stdoutFile, 'wx');
  const errFd = fs.openSync(stderrFile, 'wx');
  result.log_path = logPath;
  const limit = Number.isSafeInteger(opts.output_limit_bytes) && opts.output_limit_bytes > 0 ? Math.min(opts.output_limit_bytes, 65536) : 16384;
  let timedOut = false, spawnError = '';
  await new Promise(resolve => {
    let child, timer;
    try { child = spawn(spec.command,spec.args,{shell:false,cwd,stdio:['ignore',outFd,errFd],windowsHide:true,detached:process.platform!=='win32'}); }
    catch (error) { result.reason='spawn_failed';spawnError=error.message;resolve();return; }
    timer=setTimeout(()=>{ timedOut=true;terminateTree(child); },spec.timeout_ms);
    child.on('error',error=>{clearTimeout(timer);spawnError=error.message;result.reason='spawn_failed';resolve();});
    child.on('close',code=>{clearTimeout(timer);result.exit_code=code;resolve();});
  });
  fs.closeSync(outFd);fs.closeSync(errFd);
  const logFd=fs.openSync(absoluteLog,'wx');
  try {
    for(const source of [stdoutFile,stderrFile]) {
      const sourceFd=fs.openSync(source,'r');
      try { const chunk=Buffer.alloc(65536);let read;while((read=fs.readSync(sourceFd,chunk,0,chunk.length,null))>0)fs.writeSync(logFd,chunk,0,read); }
      finally { fs.closeSync(sourceFd); }
    }
    if(spawnError)fs.writeSync(logFd,spawnError);
  } finally { fs.closeSync(logFd); }
  function tail(file) {
    const size=fs.statSync(file).size;const length=Math.min(size,limit);const buffer=Buffer.alloc(length);const fd=fs.openSync(file,'r');
    try { fs.readSync(fd,buffer,0,length,Math.max(0,size-length)); } finally { fs.closeSync(fd); }
    let value=buffer.toString('utf8');
    while(Buffer.byteLength(value)>limit)value=value.slice(1);
    return value;
  }
  result.stdout_tail=tail(stdoutFile);result.stderr_tail=(tail(stderrFile)+spawnError).slice(-limit);
  fs.unlinkSync(stdoutFile);fs.unlinkSync(stderrFile);
  result.ok=!timedOut && !result.reason && result.exit_code===0;
  if(timedOut)result.reason='timeout';
  else if(!result.ok && !result.reason)result.reason='nonzero_exit';
  return persist(result);

  function persist(value) {
    value.duration_ms=Date.now()-started;
    if (opts.db) opts.db.prepare('INSERT INTO verification_runs(run_id,task_id,verify_id,verify_spec_hash,started_at,finished_at,exit_code,duration_ms,ok,stdout_tail,stderr_tail,log_path,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(runId,taskId,opts.verify_id||null,opts.verify_spec_hash||null,startedAt,new Date().toISOString(),value.exit_code,value.duration_ms,value.ok?1:0,value.stdout_tail,value.stderr_tail,value.log_path,value.reason||null);
    return value;
  }
}
