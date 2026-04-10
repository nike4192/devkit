import { resolve, basename } from 'path';
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { execSync } from 'child_process';
import chalk from 'chalk';

const SNAPSHOT_PATTERN = /^snapshot-(local|test|stage)-(inner|outer)-(\d{8})\.json$/;

/**
 * Resolve a container alias (e.g. "inner" → "directus-inner") or return as-is.
 */
function resolveAlias(alias, config) {
  const aliases = config.aliases || {};
  return aliases[alias] || alias;
}

/**
 * Get all defined aliases as list of { alias, container } pairs.
 */
function getAliases(config) {
  const aliases = config.aliases || {};
  return Object.entries(aliases).map(([alias, container]) => ({ alias, container }));
}

/**
 * Run a Directus CLI command inside a container.
 */
export function exec({ config, utils, projectRoot, alias, args = [] }) {
  const container = resolveAlias(alias, config);
  const cmd = ['node', 'directus/cli.js', ...args].join(' ');

  console.log(chalk.cyan(`${alias} (${container}): ${cmd}`));
  try {
    execSync(`docker exec ${container} ${cmd}`, { stdio: 'inherit', timeout: 120000 });
  } catch (e) {
    throw new Error(`Command failed in ${container}: ${e.message}`);
  }
}

// --- Snapshot subcommand ---

function formatDate() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function getLocalSnapshots(snapshotDir) {
  const dir = resolve(snapshotDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => SNAPSHOT_PATTERN.test(f))
    .map(f => {
      const m = f.match(SNAPSHOT_PATTERN);
      const fullPath = resolve(dir, f);
      let size = 0;
      try { size = statSync(fullPath).size; } catch {}
      return { name: f, path: fullPath, origin: m[1], type: m[2], date: m[3], size };
    });
}

function findSnapshotFile(options, snapshotDir) {
  if (options.src) {
    const src = resolve(options.src);
    if (!existsSync(src)) throw new Error(`File not found: ${src}`);
    const name = basename(src);
    const m = name.match(SNAPSHOT_PATTERN);
    const type = options.type || (m ? m[2] : null);
    if (!type) throw new Error(`Cannot determine type (inner/outer) from filename. Use --type`);
    return [{ path: src, name, type }];
  }

  const dir = resolve(snapshotDir);
  if (!existsSync(dir)) throw new Error(`${snapshotDir}/ folder not found`);

  let files = getLocalSnapshots(snapshotDir);
  if (options.type) files = files.filter(f => f.type === options.type);
  if (options.date) files = files.filter(f => f.date === options.date.replace(/-/g, ''));
  if (files.length === 0) throw new Error('No matching snapshots found');

  files.sort((a, b) => b.date.localeCompare(a.date));

  const latestDate = files[0].date;
  return files.filter(f => f.date === latestDate);
}

export async function snapshotDump({ config, utils, projectRoot, type, dest }) {
  const snapshotDir = dest || config.snapshot?.dir || 'snapshots';
  const aliases = getAliases(config);

  if (aliases.length === 0) {
    console.log(chalk.yellow('No container aliases configured. Add them to .devkit.d/directus.yml'));
    return;
  }

  const types = type ? [type] : aliases.map(a => a.alias);
  const destDir = resolve(snapshotDir);
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

  const date = formatDate();

  for (const t of types) {
    const container = resolveAlias(t, config);
    const fileName = `snapshot-local-${t}-${date}.json`;
    const destFile = resolve(destDir, fileName);
    const tmpFile = `/tmp/snapshot-${t}.json`;

    console.log(`${chalk.cyan(t)} (${container}): schema snapshot...`);

    execSync(
      `docker exec ${container} sh -c 'node directus/cli.js schema snapshot --format json > ${tmpFile}'`,
      { stdio: 'inherit', timeout: 60000 },
    );

    execSync(`docker cp ${container}:${tmpFile} "${destFile}"`, { timeout: 30000 });

    try { execSync(`docker exec ${container} rm ${tmpFile}`, { stdio: 'pipe', timeout: 10000 }); } catch {}

    console.log(chalk.green(`  \u2192 ${fileName}`));
  }

  console.log(chalk.green('\nDone!'));
}

export async function snapshotLoad({ config, utils, projectRoot, type, date, src }) {
  const snapshotDir = config.snapshot?.dir || 'snapshots';
  const snapshots = findSnapshotFile({ type, date, src }, snapshotDir);

  for (const snap of snapshots) {
    const container = resolveAlias(snap.type, config);
    const tmpPath = `/tmp/${snap.name}`;

    console.log(`\n${chalk.cyan(snap.type)} (${container}): applying ${snap.name}`);

    execSync(`docker cp "${snap.path}" ${container}:${tmpPath}`, { timeout: 30000 });

    try {
      execSync(
        `docker exec ${container} node directus/cli.js schema apply --yes ${tmpPath}`,
        { stdio: 'inherit', timeout: 120000 },
      );
      console.log(chalk.green(`  ${snap.type}: applied!`));
    } finally {
      try { execSync(`docker exec ${container} rm ${tmpPath}`, { stdio: 'pipe', timeout: 10000 }); } catch {}
    }
  }

  console.log(chalk.green('\nDone!'));
}

const ORIGIN_COLORS = { local: chalk.green, test: chalk.blue, stage: chalk.magenta };

export function snapshotLs({ config, utils }) {
  const snapshotDir = config.snapshot?.dir || 'snapshots';
  const files = getLocalSnapshots(snapshotDir);

  if (files.length === 0) {
    console.log(`No snapshots found (${snapshotDir}/ folder).`);
    return;
  }

  const byOrigin = {};
  for (const f of files) {
    (byOrigin[f.origin] ||= []).push(f);
  }

  for (const origin of Object.keys(byOrigin).sort()) {
    const colorFn = ORIGIN_COLORS[origin] || chalk.white;
    const items = byOrigin[origin].sort((a, b) => b.date.localeCompare(a.date));
    console.log(colorFn(`\n  ${origin} (${items.length} files):`));
    for (const item of items) {
      const dateStr = `${item.date.slice(0, 4)}-${item.date.slice(4, 6)}-${item.date.slice(6, 8)}`;
      console.log(`    ${chalk.green(dateStr)}  ${chalk.cyan(item.type)}  ${utils.formatSize(item.size)}`);
    }
  }

  console.log(`\nTotal: ${files.length} files in ${snapshotDir}/`);
}
