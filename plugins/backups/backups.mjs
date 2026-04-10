import { resolve, basename } from 'path';
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { execSync } from 'child_process';
import chalk from 'chalk';

const LOCAL_DUMP_PATTERN = /^dump-(test|stage|local)-(inner|outer)-(\d{4}-\d{2}-\d{2})_(\d{2}_\d{2}_\d{2})\.sql\.gz$/;

// --- YaDisk helpers (internal module) ---

function makeDumpPattern(env) {
  return new RegExp(`^dump-${env}-(inner|outer)-(\\d{4}-\\d{2}-\\d{2})_(\\d{2}_\\d{2}_\\d{2})\\.sql\\.gz$`);
}

function getSSHHost(env, config) {
  const server = config.servers?.[env];
  if (!server) throw new Error(`Unknown environment '${env}' (available: ${Object.keys(config.servers || {}).join(', ')})`);
  return server.ssh;
}

function hasYaDiskToken(config) {
  const envVar = config.yadisk?.token_env || 'YADISK_TOKEN';
  return !!process.env[envVar];
}

function getYaDiskToken(config) {
  const envVar = config.yadisk?.token_env || 'YADISK_TOKEN';
  return process.env[envVar];
}

function getDumpsViaSSH(mode, env, config, utils) {
  const host = getSSHHost(env, config);
  const infoScript = config.dump?.info_script || '/opt/get_dump_info.sh';
  const output = utils.sshExec(host, `${infoScript} ${mode}`);
  return JSON.parse(output);
}

async function getDumpsViaYaDisk(env, config, utils) {
  const token = getYaDiskToken(config);
  if (!token) throw new Error('YADISK_TOKEN is not set');
  const pattern = makeDumpPattern(env);
  const folder = config.yadisk?.folders?.[env];
  if (!folder) throw new Error(`YaDisk folder for '${env}' not configured`);
  const items = await utils.listYaDiskDumps(token, folder);
  return items
    .filter(item => item.type === 'file' && pattern.test(item.name))
    .map(item => {
      const m = item.name.match(pattern);
      return {
        name: item.name, path: item.path,
        type: m[1], date: m[2], time: m[3],
        size: item.size || 0, source: 'yadisk',
      };
    });
}

async function getDumps(mode, env, config, utils) {
  try {
    return getDumpsViaSSH(mode, env, config, utils);
  } catch {
    if (hasYaDiskToken(config) && (mode === 'all' || mode === 'remote')) {
      console.log(chalk.yellow(`SSH ${env} unavailable, using YaDisk API`));
      return getDumpsViaYaDisk(env, config, utils);
    }
    throw new Error(`SSH ${env} unavailable and YADISK_TOKEN not set`);
  }
}

async function getDownloadLink(dump, env, config, utils) {
  try {
    const host = getSSHHost(env, config);
    const infoScript = config.dump?.info_script || '/opt/get_dump_info.sh';
    const url = utils.sshExec(host, `${infoScript} download-link '${dump.path}'`);
    if (url.startsWith('http')) return url;
  } catch {}
  if (hasYaDiskToken(config)) {
    return utils.getYaDiskDownloadUrl(getYaDiskToken(config), dump.path);
  }
  return null;
}

function getLocalDumps() {
  const dir = resolve('backups');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => LOCAL_DUMP_PATTERN.test(f))
    .map(f => {
      const m = f.match(LOCAL_DUMP_PATTERN);
      const fullPath = resolve(dir, f);
      let size = 0;
      try { size = statSync(fullPath).size; } catch {}
      return {
        name: f, path: fullPath,
        origin: m[1], type: m[2], date: m[3], time: m[4],
        size, source: 'local',
      };
    });
}

function groupDumps(dumps) {
  const groups = {};
  for (const d of dumps) {
    const key = `${d.date}_${d.time}`;
    (groups[key] ||= []).push(d);
  }
  return groups;
}

function findDumpFile(options) {
  if (options.src) {
    const src = resolve(options.src);
    if (!existsSync(src)) throw new Error(`File not found: ${src}`);
    const name = basename(src);
    const m = name.match(LOCAL_DUMP_PATTERN);
    const type = options.type || (m ? m[2] : null);
    if (!type) throw new Error(`Cannot determine type (inner/outer) from filename. Use --type`);
    return [{ path: src, name, type }];
  }

  const dir = resolve('backups');
  if (!existsSync(dir)) throw new Error('backups/ folder not found');

  let files = readdirSync(dir)
    .filter(f => LOCAL_DUMP_PATTERN.test(f))
    .map(f => {
      const m = f.match(LOCAL_DUMP_PATTERN);
      return { name: f, path: resolve(dir, f), type: m[2], date: m[3], time: m[4] };
    });

  if (options.type) files = files.filter(f => f.type === options.type);
  if (options.date) files = files.filter(f => f.date === options.date);
  if (files.length === 0) throw new Error('No matching dumps found');

  files.sort((a, b) => `${b.date}_${b.time}`.localeCompare(`${a.date}_${a.time}`));

  const latestKey = `${files[0].date}_${files[0].time}`;
  return files.filter(f => `${f.date}_${f.time}` === latestKey);
}

// --- Commands ---

const ORIGIN_COLORS = { test: chalk.blue, stage: chalk.magenta, local: chalk.green };

export function ls({ utils }) {
  const dumps = getLocalDumps();
  if (dumps.length === 0) { console.log('No local dumps found (backups/ folder).'); return; }

  const byOrigin = {};
  for (const d of dumps) {
    (byOrigin[d.origin] ||= []).push(d);
  }

  const origins = Object.keys(byOrigin).sort();
  let totalFiles = 0;

  for (const origin of origins) {
    const colorFn = ORIGIN_COLORS[origin] || chalk.white;
    const items = byOrigin[origin];
    const groups = groupDumps(items);
    const sortedKeys = Object.keys(groups).sort().reverse();
    totalFiles += items.length;

    console.log(colorFn(`\n  ${origin} (${items.length} files):`));

    for (const key of sortedKeys) {
      const group = groups[key];
      const date = group[0].date;
      const time = group[0].time.replace(/_/g, ':');
      const types = group.map(d => chalk.cyan(d.type)).join(', ');
      const sizes = group.map(d => utils.formatSize(d.size)).join(' + ');
      const total = utils.formatSize(group.reduce((s, d) => s + d.size, 0));

      console.log(`    ${chalk.green(date)} ${time}  [${types}]  ${sizes} (${total})`);
    }
  }

  console.log(`\nTotal: ${totalFiles} files in backups/`);
}

export async function list({ config, utils, env = 'test', source = 'all' }) {
  let dumps;

  console.log(chalk.bold(`Environment: ${env}\n`));

  if (source === 'yadisk') {
    dumps = await getDumpsViaYaDisk(env, config, utils);
  } else if (source === 'server') {
    dumps = getDumpsViaSSH('local', env, config, utils);
  } else {
    const mode = { all: 'all', server: 'local', yadisk: 'remote' }[source];
    dumps = await getDumps(mode, env, config, utils);
  }

  if (dumps.length === 0) { console.log('No dumps found.'); return; }

  const groups = groupDumps(dumps);
  const sortedKeys = Object.keys(groups).sort().reverse();

  console.log(`Found ${dumps.length} files (${sortedKeys.length} backups):\n`);

  for (const key of sortedKeys) {
    const items = groups[key];
    const date = items[0].date;
    const time = items[0].time.replace(/_/g, ':');
    const types = items.map(d => chalk.cyan(d.type)).join(', ');
    const sizes = items.map(d => utils.formatSize(d.size)).join(' + ');
    const total = utils.formatSize(items.reduce((s, d) => s + d.size, 0));
    const sources = [...new Set(items.map(d => d.source))].map(s =>
      s === 'yadisk' ? chalk.yellow(s) : chalk.green(s)
    ).join('/');

    console.log(`  ${chalk.green(date)} ${time}  [${types}]  ${sizes} (total ${total})  \u2190 ${sources}`);
  }
}

export async function pull({ config, utils, env = 'test', type, date, source = 'auto', dest = 'backups' }) {
  let dumps = await getDumps('all', env, config, utils);
  if (dumps.length === 0) throw new Error('No dumps found');

  console.log(chalk.bold(`Environment: ${env}\n`));

  if (date) {
    dumps = dumps.filter(d => d.date === date);
    if (dumps.length === 0) throw new Error(`No dumps found for ${date}`);
  }

  if (type) {
    dumps = dumps.filter(d => d.type === type);
    if (dumps.length === 0) throw new Error(`No dumps found for type '${type}'`);
  }

  if (source === 'server') {
    dumps = dumps.filter(d => d.source === 'server');
    if (dumps.length === 0) throw new Error('None on server. Try --source yadisk');
  } else if (source === 'yadisk') {
    dumps = dumps.filter(d => d.source === 'yadisk');
    if (dumps.length === 0) throw new Error('None on YaDisk');
  }

  const groups = groupDumps(dumps);
  const latestKey = Object.keys(groups).sort().reverse()[0];
  let toDownload = groups[latestKey];

  if (source === 'auto') {
    const serverDumps = toDownload.filter(d => d.source === 'server');
    const yadiskDumps = toDownload.filter(d => d.source === 'yadisk');
    const seenTypes = new Set();
    const chosen = [];
    for (const d of serverDumps) { chosen.push(d); seenTypes.add(d.type); }
    for (const d of yadiskDumps) { if (!seenTypes.has(d.type)) chosen.push(d); }
    toDownload = chosen;
  }

  const destDir = resolve(dest);
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

  const host = getSSHHost(env, config);
  const dumpDate = toDownload[0].date;
  const dumpTime = toDownload[0].time.replace(/_/g, ':');
  console.log(`Downloading dumps for ${dumpDate} ${dumpTime}:\n`);

  for (const dump of toDownload) {
    const destFile = resolve(destDir, dump.name);

    if (dump.source === 'server') {
      console.log(`  ${chalk.green('scp')}    ${dump.name} (${utils.formatSize(dump.size)})`);
      utils.scpDownload(host, dump.path, destFile);
    } else {
      console.log(`  ${chalk.yellow('yadisk')} ${dump.name} (${utils.formatSize(dump.size)})`);
      const url = await getDownloadLink(dump, env, config, utils);
      if (!url) { console.log(chalk.red('    Failed to get download link')); continue; }
      await utils.downloadFromUrl(url, destFile, dump.size);
    }
  }

  console.log(chalk.green('\nDone!'));
}

export async function dump({ config, utils, projectRoot, type, dest = 'backups' }) {
  const composeFile = config.compose_file || 'docker-compose.dev.yml';
  const containers = utils.getComposeContainers(projectRoot, composeFile);
  const types = type ? [type] : Object.keys(containers);
  const destDir = resolve(dest);
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 8).replace(/:/g, '_');

  for (const t of types) {
    const cfg = containers[t];
    if (!cfg) throw new Error(`No configuration for type '${t}'`);

    const fileName = `dump-local-${t}-${date}_${time}.sql.gz`;
    const destFile = resolve(destDir, fileName);

    console.log(`${chalk.cyan(t)}: dumping ${cfg.dbName} from ${cfg.pgContainer}...`);

    execSync(
      `docker exec ${cfg.pgContainer} pg_dump -U ${cfg.dbUser} ${cfg.dbName} | gzip > "${destFile}"`,
      { stdio: ['pipe', 'pipe', 'inherit'], timeout: 300000 },
    );

    console.log(chalk.green(`  \u2192 ${fileName}`));
  }

  console.log(chalk.green('\nDone!'));
}

export async function load({ config, utils, projectRoot, type, date, src }) {
  const dumps = findDumpFile({ type, date, src });
  const composeFile = config.compose_file || 'docker-compose.dev.yml';
  const containers = utils.getComposeContainers(projectRoot, composeFile);

  for (const dump of dumps) {
    const cfg = containers[dump.type];
    if (!cfg) throw new Error(`No configuration for type '${dump.type}'`);

    console.log(`\n${chalk.cyan(dump.type)}: loading ${dump.name} \u2192 ${cfg.pgContainer}`);

    console.log('  Stopping Directus...');
    execSync(`docker stop ${cfg.appContainer}`, { stdio: 'pipe', timeout: 30000 });

    try {
      console.log('  Recreating DB...');
      utils.dockerExec(cfg.pgContainer, `dropdb -U ${cfg.dbUser} --force --if-exists ${cfg.dbName}`);
      utils.dockerExec(cfg.pgContainer, `createdb -U ${cfg.dbUser} ${cfg.dbName}`);

      console.log('  Restoring dump...');
      execSync(
        `gunzip -c "${dump.path}" | docker exec -i ${cfg.pgContainer} psql -U ${cfg.dbUser} -d ${cfg.dbName}`,
        { stdio: ['pipe', 'pipe', 'inherit'], timeout: 600000 },
      );

      console.log(chalk.green(`  ${dump.type}: loaded!`));
    } finally {
      console.log('  Starting Directus...');
      execSync(`docker start ${cfg.appContainer}`, { stdio: 'pipe', timeout: 30000 });
    }
  }

  console.log(chalk.green('\nDone!'));
}
