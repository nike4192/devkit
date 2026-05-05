import { resolve } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import chalk from 'chalk';
import { deepMerge } from './loader.mjs';
import { getProvider, interpolate } from './providers/index.mjs';

/**
 * Collect all env_vars declarations across enabled plugins.
 *
 * Returns an array of:
 *   { name, spec, plugin, pluginConfig }
 *
 * `spec.open_url` and `spec.hint` are interpolated against pluginConfig
 * (so .devkit.d/env.yml can put `{project_id}` into a URL template).
 */
function collectDeclarations({ devkitRoot, projectRoot, plugins }) {
  const decls = [];

  for (const entry of plugins) {
    const { name, path: extPath } = entry;
    if (extPath) continue; // RPC plugins don't ship env_vars yet

    const pluginDir = resolve(devkitRoot, 'plugins', name);
    const defaultsPath = resolve(pluginDir, 'config.yml');
    if (!existsSync(defaultsPath)) continue;

    let config = parseYaml(readFileSync(defaultsPath, 'utf-8')) || {};
    const overridePath = resolve(projectRoot, '.devkit.d', `${name}.yml`);
    if (existsSync(overridePath)) {
      const overrides = parseYaml(readFileSync(overridePath, 'utf-8')) || {};
      config = deepMerge(config, overrides);
    }

    const envVars = config.env_vars || {};
    for (const [varName, rawSpec] of Object.entries(envVars)) {
      const spec = { ...rawSpec };
      if (spec.open_url) spec.open_url = interpolate(spec.open_url, config);
      if (spec.hint) spec.hint = interpolate(spec.hint, config);
      decls.push({ name: varName, spec, plugin: name, pluginConfig: config });
    }
  }

  return decls;
}

/**
 * Read the project root .env into a flat key→value map.
 * Empty values count as "missing" — those are still treated as needing input.
 */
function readEnvFile(envPath) {
  if (!existsSync(envPath)) return {};
  const map = {};
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
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
    map[key] = value;
  }
  return map;
}

/**
 * Interactive collection of missing required env vars.
 *
 * @param {object} args
 * @param {string} args.devkitRoot
 * @param {string} args.projectRoot
 * @param {Array<{name:string, path?:string}>} args.plugins   from findProject()
 * @param {object} args.utils                                 from core/utils.mjs
 * @param {boolean} [args.force]                              re-prompt even if values exist
 * @param {boolean} [args.nonInteractive]                     fail with list instead of prompting
 */
export async function collectEnvVars({ devkitRoot, projectRoot, plugins, utils, force = false, nonInteractive = false }) {
  const envPath = resolve(projectRoot, '.env');
  const examplePath = resolve(projectRoot, '.env.example');

  // Pre-load existing .env (or .env.example as fallback) into process.env so
  // declarations can interpolate {env:VAR} references like YADISK_CLIENT_ID.
  if (existsSync(envPath)) utils.loadEnv(envPath);
  else if (existsSync(examplePath)) utils.loadEnv(examplePath);

  const decls = collectDeclarations({ devkitRoot, projectRoot, plugins });
  if (decls.length === 0) return { collected: 0, written: 0 };

  const current = readEnvFile(envPath);

  const missing = decls.filter(d => {
    if (force) return true;
    const v = current[d.name];
    if (v && v.length > 0) return false;
    // Also accept value already exported in the parent shell
    if (process.env[d.name]) return false;
    return d.spec.required !== false;
  });

  if (missing.length === 0) {
    console.log(chalk.dim('  All required env vars present in .env'));
    return { collected: 0, written: 0 };
  }

  if (nonInteractive) {
    const lines = missing.map(d => `  - ${d.name}${d.spec.description ? ` (${d.spec.description})` : ''}`);
    throw new Error(`Missing env vars in ${envPath}:\n${lines.join('\n')}\n\nRun 'devkit setup' interactively to fill them in.`);
  }

  console.log(chalk.dim(`  ${missing.length} value(s) needed — you'll be prompted for each`));

  const answers = {};
  for (const decl of missing) {
    console.log();
    console.log(chalk.bold(`[${decl.plugin}] ${decl.name}`));
    const provider = getProvider(decl.spec.provider);
    const value = await provider({
      name: decl.name,
      spec: decl.spec,
      currentValue: current[decl.name] || '',
    });
    if (value && value.length > 0) {
      answers[decl.name] = value;
    }
  }

  if (Object.keys(answers).length === 0) {
    return { collected: missing.length, written: 0 };
  }

  // Merge into .env (create from .env.example if missing, else from blank)
  let envContent = '';
  if (existsSync(envPath)) {
    envContent = readFileSync(envPath, 'utf-8');
  } else {
    const examplePath = resolve(projectRoot, '.env.example');
    if (existsSync(examplePath)) {
      envContent = readFileSync(examplePath, 'utf-8');
      console.log(chalk.dim(`\n  Created .env from .env.example`));
    }
  }

  const { content, updated } = utils.mergeSecretsIntoEnv(envContent, answers);
  writeFileSync(envPath, content);

  // Also export to current process so subsequent setup steps see them
  for (const [k, v] of Object.entries(answers)) {
    process.env[k] = v;
  }

  console.log(chalk.green(`\n  Wrote ${updated} value(s) to ${envPath}`));
  return { collected: missing.length, written: updated };
}
