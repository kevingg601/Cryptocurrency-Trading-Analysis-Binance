import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import ts from 'typescript';
import * as asar from '@electron/asar';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseName = process.argv[2] ?? '20261030-ai-ab-fixed';
if (!/^[a-zA-Z0-9-]+$/.test(releaseName)) throw new Error('Invalid release name');
const staging = path.join(root, 'dist-desktop', releaseName, 'app-staging');
const resources = path.join(root, 'dist-desktop', releaseName, 'win-unpacked', 'resources');
const archive = path.join(resources, 'app.asar');
if (await fs.stat(staging).catch(() => null)) throw new Error('Staging already exists; preserve it with a new release name');
await fs.access(path.join(root, 'apps/web/dist/index.html'));
await fs.mkdir(staging, { recursive: true });

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const manifest = { releaseName, createdAt: new Date().toISOString(), sources: {}, dependencies: {} };
async function copy(relative) {
  const target = path.join(staging, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(path.join(root, relative), target, { recursive: true, dereference: true });
}
async function compile(sourceDir, targetDir) {
  await fs.mkdir(path.join(staging, targetDir), { recursive: true });
  for (const entry of await fs.readdir(path.join(root, sourceDir), { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) { await compile(source, target); continue; }
    const input = await fs.readFile(path.join(root, source));
    manifest.sources[source.replaceAll('\\', '/')] = sha(input);
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      const result = ts.transpileModule(input.toString('utf8'), { fileName: source,
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true, verbatimModuleSyntax: true },
        reportDiagnostics: true });
      if (result.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) throw new Error(`Transpile error: ${source}`);
      await fs.writeFile(path.join(staging, target.replace(/\.ts$/, '.js')), result.outputText);
    } else if (!entry.name.endsWith('.d.ts')) await fs.writeFile(path.join(staging, target), input);
  }
}
await compile('apps/collector/src', 'apps/collector/src');
await compile('packages/core/src', 'packages/core/src');
await copy('apps/web/dist');
await copy('apps/desktop/main.cjs');
await copy('apps/desktop/preload.cjs');
await fs.writeFile(path.join(staging, 'package.json'), JSON.stringify({
  name: 'fadachi', version: '1.0.0', private: true, main: 'apps/desktop/main.cjs',
}, null, 2));
await fs.writeFile(path.join(staging, 'apps/collector/package.json'), JSON.stringify({ name: '@fadachi/collector', type: 'module', main: 'src/main.js' }));
await fs.writeFile(path.join(staging, 'packages/core/package.json'), JSON.stringify({ name: '@fadachi/core', type: 'module', main: 'src/index.js' }));
const shim = path.join(staging, 'node_modules/@fadachi/core');
await fs.mkdir(shim, { recursive: true });
await fs.writeFile(path.join(shim, 'package.json'), JSON.stringify({ name: '@fadachi/core', type: 'module', exports: './index.js' }));
await fs.writeFile(path.join(shim, 'index.js'), "export * from '../../../packages/core/src/index.js';\n");

// Resolve each installed package from its actual parent to preserve nested versions.
const seen = new Set();
async function includeDependency(name, parent) {
  if (name === '@fadachi/core') return;
  const require = createRequire(path.join(parent, 'package.json'));
  let packageFile;
  try { packageFile = require.resolve(`${name}/package.json`); }
  catch {
    let directory = path.dirname(require.resolve(name));
    while (directory !== path.dirname(directory)) {
      const candidate = path.join(directory, 'package.json');
      const pkg = await fs.readFile(candidate, 'utf8').then(JSON.parse).catch(() => null);
      if (pkg?.name === name) { packageFile = candidate; break; }
      directory = path.dirname(directory);
    }
  }
  if (!packageFile) throw new Error(`Cannot locate dependency ${name}`);
  const directory = path.dirname(packageFile);
  if (seen.has(directory)) return;
  const relative = path.relative(root, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !relative.split(path.sep).includes('node_modules')) throw new Error(`Dependency outside workspace: ${name}`);
  seen.add(directory);
  const pkg = JSON.parse(await fs.readFile(packageFile, 'utf8'));
  manifest.dependencies[relative.replaceAll('\\', '/')] = { name: pkg.name, version: pkg.version };
  await copy(relative);
  for (const dependency of Object.keys(pkg.dependencies ?? {})) await includeDependency(dependency, directory);
  for (const dependency of Object.keys(pkg.optionalDependencies ?? {})) {
    try { await includeDependency(dependency, directory); }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  }
}
const collector = JSON.parse(await fs.readFile(path.join(root, 'apps/collector/package.json'), 'utf8'));
for (const name of Object.keys(collector.dependencies)) await includeDependency(name, path.join(root, 'apps/collector'));
await fs.writeFile(path.join(staging, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
await fs.mkdir(resources, { recursive: true });
await asar.createPackageWithOptions(staging, archive, { unpackDir: '{node_modules,apps/collector,packages/core}/**' });
for (const relative of ['apps/collector/src/main.js', 'apps/collector/src/storage/duckdbWorker.js', 'packages/core/src/index.js',
  'node_modules/duckdb/lib/binding/duckdb.node']) {
  if (!asar.statFile(archive, relative).unpacked) throw new Error(`Runtime file was not unpacked: ${relative}`);
  await fs.access(path.join(`${archive}.unpacked`, relative));
}
const packaged = asar.extractFile(archive, 'package.json').toString();
if (JSON.parse(packaged).main !== 'apps/desktop/main.cjs') throw new Error('Incorrect desktop entry');
console.log(JSON.stringify({ archive, sourceFiles: Object.keys(manifest.sources).length, runtimeDependencies: seen.size, asarSha256: sha(await fs.readFile(archive)) }, null, 2));
