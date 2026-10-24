import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as A from './admin-config.mjs';
import { BUS_DIR } from './store.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-project-'));
const bus = path.join(tmp, 'bus');
const options = { path: path.join(bus, 'projects.json'), workspaceRoot: path.join(tmp, 'workspaces') };
let pass = 0;
function check(name, fn) { fn(); pass++; console.log('PASS ' + name); }
function reject(input, pattern) { assert.throws(() => A.createProject(input, options), pattern); }
const actualRegistry = path.join(BUS_DIR, 'projects.json');
const actualSnapshot = fs.readFileSync(actualRegistry, 'utf8');
try {
  fs.mkdirSync(bus);
  for (const file of ['store.mjs', 'schema.sql', 'redline.mjs', 'migrations.mjs', 'execution-grant.mjs', 'verifier.mjs']) {
    fs.copyFileSync(path.join(BUS_DIR, file), path.join(bus, file));
  }
  const S = await import(pathToFileURL(path.join(bus, 'store.mjs')).href);
  check('missing registry reads empty without creating files', () => {
    assert.deepEqual(A.readProjectsRegistry(options), { projects: {} });
    assert(!fs.existsSync(options.path));
  });
  const original = { _note: 'keep note', extra: { keep: true }, projects: {
    existing: { path: tmp, topology: 'shared', agents: [] }, default: { path: tmp },
  } };
  fs.writeFileSync(options.path, JSON.stringify(original));
  const target = path.join(tmp, 'external');
  fs.mkdirSync(target);
  const made = A.createProject({ id: 'Example', path: target, topology: 'shared', agents: ['codex/main'] }, options);
  check('explicit path gets config and is resolved by actual store', () => {
    assert.equal(made.ok, true);
    assert.equal(made.config_path, path.join(target, 'project.json'));
    const config = JSON.parse(fs.readFileSync(made.config_path, 'utf8'));
    assert.equal(config.id, 'Example');
    assert.equal(config.topology, 'shared');
    assert.deepEqual(config.agents, ['codex/main']);
    assert.equal(S.resolveProjectDir('Example'), target);
    const ws = S.workspaceFor(null, 'Example', 'codex/main', 'task');
    assert.equal(ws.topology, 'shared');
    assert.equal(ws.root, target);
    assert.equal(ws.cwd, target);
    assert.equal(ws.lock_required, true);
  });
  check('registry keeps note and prior projects with timestamped backup', () => {
    const registry = A.readProjectsRegistry(options);
    assert.equal(registry._note, original._note);
    assert.deepEqual(registry.projects.existing, original.projects.existing);
    assert.deepEqual(registry.extra, original.extra);
    const backup = fs.readdirSync(bus).find(name => name.startsWith('projects.json.bak-'));
    assert(backup);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bus, backup), 'utf8')), original);
  });
  check('omitted path creates workspace with default topology and agents', () => {
    const result = A.createProject({ id: 'local-project' }, options);
    const root = path.join(options.workspaceRoot, 'local-project');
    assert.equal(result.project.path, root);
    assert.equal(result.project.topology, 'clone-per-agent');
    assert.deepEqual(result.project.agents, []);
    assert.equal(result.config_path, path.join(root, 'project.json'));
    const ws = S.workspaceFor(null, result.id, 'codex/main', 'task');
    assert.equal(ws.root, root);
    assert.equal(ws.cwd, path.join(root, 'codex-main'));
    assert.equal(ws.topology, 'clone-per-agent');
  });
  check('blank path uses the default workspace directory', () => {
    const result = A.createProject({ id: 'blank-project', path: '   ' }, options);
    assert.equal(result.project.path, path.join(options.workspaceRoot, 'blank-project'));
    assert(fs.existsSync(result.config_path));
  });
  check('isolated topology produces an agent-specific workspace', () => {
    A.createProject({ id: 'isolated-project', topology: 'isolated' }, options);
    const root = path.join(options.workspaceRoot, 'isolated-project');
    const ws = S.workspaceFor(null, 'isolated-project', 'claude/main', 'task');
    assert.equal(ws.cwd, path.join(root, 'claude-main'));
    assert.equal(ws.topology, 'isolated');
  });
  check('case-insensitive duplicates are rejected without replacing config', () => {
    const before = fs.readFileSync(made.config_path, 'utf8');
    reject({ id: 'example', path: target }, /已登记/);
    assert.equal(fs.readFileSync(made.config_path, 'utf8'), before);
  });
  check('invalid ids cannot escape workspace root', () => {
    for (const id of ['a', '../bad', 'bad/name', '_bad', '.', 'a'.repeat(42), '', null]) {
      reject({ id, path: target }, /项目 id/);
    }
  });
  check('relative paths and missing directories are rejected', () => {
    reject({ id: 'relative-project', path: 'relative' }, /绝对路径/);
    reject({ id: 'missing-project', path: path.join(tmp, 'not-there') }, /目录不存在/);
    reject({ id: 'file-project', path: options.path }, /已存在的目录/);
  });
  check('topology and agents types are validated', () => {
    reject({ id: 'bad-topology', path: target, topology: 'other' }, /topology/);
    for (const agents of [null, 'codex/main', [5], ['wrong'], ['codex/main', {}]]) {
      reject({ id: 'bad-agents', path: target, agents }, /agents/);
    }
  });
  check('exclusive registry lock prevents competing writers', () => {
    fs.writeFileSync(options.path + '.lock', '');
    try { reject({ id: 'locked-project', path: target }, /正在更新/); }
    finally { fs.unlinkSync(options.path + '.lock'); }
    assert(!A.readProjectsRegistry(options).projects['locked-project']);
  });
  check('delete cleans generated config while preserving directory and other projects', () => {
    assert.deepEqual(A.deleteProject('eXAMPLE', options), { ok: true });
    const registry = A.readProjectsRegistry(options);
    assert(!registry.projects.Example);
    assert(registry.projects.existing);
    assert.equal(registry._note, original._note);
    assert(!fs.existsSync(made.config_path));
    assert(fs.statSync(target).isDirectory());
  });
  check('delete preserves a user-owned project config and source files', () => {
    const userConfig = path.join(target, 'project.json');
    const userContent = JSON.stringify({ id: 'existing', root: target, topology: 'shared' });
    fs.writeFileSync(userConfig, userContent);
    const registry = A.readProjectsRegistry(options);
    registry.projects.existing.path = target;
    fs.writeFileSync(options.path, JSON.stringify(registry));
    A.deleteProject('existing', options);
    assert.equal(fs.readFileSync(userConfig, 'utf8'), userContent);
  });
  check('unknown and default deletion are rejected without writes', () => {
    const before = fs.readFileSync(options.path, 'utf8');
    assert.throws(() => A.deleteProject('unknown', options), /未登记/);
    assert.throws(() => A.deleteProject('default', options), /不能删除/);
    assert.throws(() => A.deleteProject('DEFAULT', options), /不能删除/);
    assert.equal(fs.readFileSync(options.path, 'utf8'), before);
  });
  check('malformed registry is rejected instead of silently replaced', () => {
    const malformed = { path: path.join(tmp, 'malformed.json'), workspaceRoot: options.workspaceRoot };
    fs.writeFileSync(malformed.path, '{broken');
    assert.throws(() => A.readProjectsRegistry(malformed), /JSON 无效/);
    assert.throws(() => A.createProject({ id: 'valid-project', path: target }, malformed), /JSON 无效/);
    assert.equal(fs.readFileSync(malformed.path, 'utf8'), '{broken');
  });
  check('production registry remains byte-for-byte unchanged', () => {
    assert.equal(fs.readFileSync(actualRegistry, 'utf8'), actualSnapshot);
  });
  console.log('PASS ' + pass + '   FAIL 0');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
