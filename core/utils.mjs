import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, basename } from 'path';
import chalk from 'chalk';
import { parse as parseYaml } from 'yaml';
import { InfisicalClient } from '@infisical/sdk';

// --- .env ---

export function loadEnv(filePath) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

export function parseEnv(content) {
  const result = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

export function mergeSecretsIntoEnv(envContent, secrets) {
  const existing = parseEnv(envContent);
  const lines = envContent.split('\n');
  let updated = 0;

  for (const [key, value] of Object.entries(secrets)) {
    if (key in existing) {
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith(`${key}=`) || trimmed.startsWith(`${key} =`)) {
          lines[i] = `${key}=${value}`;
          updated++;
          break;
        }
      }
    } else {
      lines.push(`${key}=${value}`);
      updated++;
    }
  }

  return { content: lines.join('\n'), updated };
}

// --- Docker / Compose ---

export function parseComposeFile(projectRoot, composeFile = 'docker-compose.dev.yml') {
  const composePath = resolve(projectRoot, composeFile);
  if (!existsSync(composePath)) {
    throw new Error(`Compose file not found: ${composePath}`);
  }
  return parseYaml(readFileSync(composePath, 'utf-8'));
}

export function getComposeExternalNetworks(projectRoot, composeFile) {
  const doc = parseComposeFile(projectRoot, composeFile);
  const networks = doc.networks || {};
  const external = [];
  for (const [name, cfg] of Object.entries(networks)) {
    if (cfg && cfg.external) {
      external.push(name);
    }
  }
  return external;
}

export function ensureDockerNetworks(projectRoot, composeFile) {
  const networks = getComposeExternalNetworks(projectRoot, composeFile);
  if (networks.length === 0) return [];

  const existing = execSync('docker network ls --format "{{.Name}}"', { encoding: 'utf-8' })
    .trim().split('\n').filter(Boolean);

  const created = [];
  for (const net of networks) {
    if (!existing.includes(net)) {
      execSync(`docker network create ${net}`, { encoding: 'utf-8' });
      created.push(net);
    }
  }
  return created;
}

export function getComposeContainers(projectRoot, composeFile) {
  const doc = parseComposeFile(projectRoot, composeFile);
  const services = doc.services || {};
  const result = {};

  for (const [name, svc] of Object.entries(services)) {
    const match = name.match(/^postgres-(inner|outer)$/);
    if (!match) continue;
    const variant = match[1];

    const containerName = svc.container_name || name;

    const envFiles = Array.isArray(svc.env_file) ? svc.env_file : [svc.env_file].filter(Boolean);
    let dbUser = 'postgres';
    let dbName = 'crosses';

    for (const ef of envFiles) {
      const envPath = resolve(projectRoot, ef);
      if (!existsSync(envPath)) continue;
      const vars = parseEnv(readFileSync(envPath, 'utf-8'));
      if (vars.DB_USER) dbUser = vars.DB_USER;
      if (vars.DB_DATABASE) dbName = vars.DB_DATABASE;
    }

    const appServiceName = `directus-${variant}`;
    const appSvc = services[appServiceName];
    const appContainer = appSvc?.container_name || appServiceName;

    result[variant] = { pgContainer: containerName, appContainer, dbUser, dbName };
  }

  return result;
}

export function dockerExec(container, cmd, options = {}) {
  const flags = options.interactive ? '-i' : '';
  return execSync(`docker exec ${flags} ${container} ${cmd}`, {
    encoding: options.encoding || 'utf-8',
    stdio: options.stdio || 'pipe',
    timeout: options.timeout || 60000,
    ...options.execOptions,
  });
}

// --- SSH ---

export function sshExec(host, cmd) {
  return execSync(`ssh ${host} '${cmd}'`, { encoding: 'utf-8', timeout: 30000 }).trim();
}

export function sshReadFile(host, path) {
  try { return sshExec(host, `cat ${path}`); } catch { return ''; }
}

export function sshWriteFile(host, path, content) {
  execSync(`ssh ${host} 'cat > ${path}'`, { input: content, encoding: 'utf-8', timeout: 10000 });
}

export function scpDownload(host, remotePath, localPath) {
  execSync(`scp ${host}:${remotePath} ${localPath}`, { stdio: 'inherit' });
}

// --- Infisical SDK ---

const infisicalClients = new Map();

export async function getInfisicalClient({ siteUrl, clientId, clientSecret }) {
  const key = `${siteUrl}:${clientId}`;
  if (infisicalClients.has(key)) return infisicalClients.get(key);

  const client = new InfisicalClient({
    siteUrl,
    auth: {
      universalAuth: { clientId, clientSecret },
    },
  });
  infisicalClients.set(key, client);
  return client;
}

export async function fetchInfisicalSecrets({ siteUrl, clientId, clientSecret, projectId, envSlug, secretPath }) {
  const client = await getInfisicalClient({ siteUrl, clientId, clientSecret });
  return client.listSecrets({
    projectId,
    environment: envSlug,
    path: secretPath,
  });
}

// --- YaDisk API ---

async function yadiskRequest(path, token, params = {}) {
  const url = new URL(`https://cloud-api.yandex.net/v1/disk/resources${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const resp = await fetch(url, { headers: { Authorization: `OAuth ${token}` } });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`YaDisk API (${resp.status}): ${body}`);
  }
  return resp.json();
}

export async function listYaDiskDumps(token, folder) {
  const data = await yadiskRequest('', token, { path: folder, limit: '200', sort: '-modified' });
  return (data._embedded?.items || []);
}

export async function getYaDiskDownloadUrl(token, filePath) {
  const data = await yadiskRequest('/download', token, { path: filePath });
  return data.href;
}

export async function downloadFromUrl(url, destPath, size = 0) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);

  const total = size || parseInt(resp.headers.get('content-length') || '0', 10);
  const reader = resp.body.getReader();
  const chunks = [];
  let downloaded = 0;

  const fileName = basename(destPath);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    downloaded += value.length;
    if (total) {
      const pct = Math.round((downloaded / total) * 100);
      const bar = '\u2588'.repeat(Math.round(pct / 2)) + '\u2591'.repeat(50 - Math.round(pct / 2));
      process.stdout.write(`\r  ${fileName} ${bar} ${pct}%`);
    }
  }
  if (total) process.stdout.write('\n');

  const buffer = Buffer.concat(chunks);
  writeFileSync(destPath, buffer);
}

// --- Formatting ---

export function formatSize(bytes) {
  for (const unit of ['B', 'KB', 'MB', 'GB']) {
    if (bytes < 1024) return `${bytes.toFixed(1)} ${unit}`;
    bytes /= 1024;
  }
  return `${bytes.toFixed(1)} TB`;
}
