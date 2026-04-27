import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { parse as parseYaml } from 'yaml';
import chalk from 'chalk';
import { registerRpcPlugin } from './rpc-plugin.mjs';

/**
 * Find the project root by walking up from cwd looking for a .devkit file.
 * @returns {{ projectRoot: string, plugins: string[] }} or throws
 */
export function findProject(startDir = process.cwd()) {
  let dir = resolve(startDir);
  const root = resolve('/');

  while (dir !== root) {
    const manifestPath = resolve(dir, '.devkit');
    if (existsSync(manifestPath)) {
      const plugins = parseManifest(manifestPath);
      return { projectRoot: dir, plugins };
    }
    dir = dirname(dir);
  }

  throw new Error(
    'No .devkit manifest found.\n' +
    'Create a .devkit file in your project root listing the plugins you need:\n\n' +
    '  # .devkit\n' +
    '  env\n' +
    '  backups\n' +
    '  docker\n'
  );
}

/**
 * Parse .devkit manifest — plain text, one plugin per line, # for comments.
 *
 * Each line is one of:
 *   <name>                 — builtin plugin from devkitRoot/plugins/<name>/
 *   <name>=<path>          — external RPC plugin (path with plugin.json),
 *                            relative path is resolved against project root.
 *
 * Returns an array of { name, path? } entries.
 */
function parseManifest(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const eq = line.indexOf('=');
      if (eq === -1) return { name: line };
      return {
        name: line.slice(0, eq).trim(),
        path: line.slice(eq + 1).trim(),
      };
    });
}

/**
 * Deep merge two objects. Arrays are replaced, not concatenated.
 */
export function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Load plugin config: merge plugin defaults with project overrides.
 */
function loadPluginConfig(pluginDir, projectRoot, pluginName) {
  // Layer 1: Plugin defaults
  let config = {};
  const defaultsPath = resolve(pluginDir, 'config.yml');
  if (existsSync(defaultsPath)) {
    config = parseYaml(readFileSync(defaultsPath, 'utf-8')) || {};
  }

  // Layer 2: Project overrides (.devkit.d/{name}.yml)
  const overridePath = resolve(projectRoot, '.devkit.d', `${pluginName}.yml`);
  if (existsSync(overridePath)) {
    const overrides = parseYaml(readFileSync(overridePath, 'utf-8')) || {};
    config = deepMerge(config, overrides);
  }

  return config;
}

/**
 * Load and register all plugins from the manifest.
 *
 * @param {import('commander').Command} program
 * @param {object} utils — shared utilities from core/utils.mjs
 * @param {string} devkitRoot — path to devkit package root
 */
export async function loadPlugins(program, utils, devkitRoot) {
  const { projectRoot, plugins } = findProject();

  const pluginsDir = resolve(devkitRoot, 'plugins');

  for (const entry of plugins) {
    const { name, path: extPath } = entry;

    // External RPC plugin: <name>=<path>
    if (extPath) {
      const pluginDir = resolve(projectRoot, extPath);
      if (!existsSync(resolve(pluginDir, 'plugin.json'))) {
        console.warn(chalk.yellow(`  Warning: external plugin '${name}' has no plugin.json at ${pluginDir}/`));
        continue;
      }
      try {
        const overridePath = resolve(projectRoot, '.devkit.d', `${name}.yml`);
        const config = existsSync(overridePath)
          ? (parseYaml(readFileSync(overridePath, 'utf-8')) || {})
          : null;
        registerRpcPlugin(program, name, pluginDir, { config, projectRoot });
      } catch (e) {
        console.error(chalk.red(`  Error loading external plugin '${name}': ${e.message}`));
      }
      continue;
    }

    // Builtin plugin: load from devkitRoot/plugins/<name>/index.mjs
    const pluginDir = resolve(pluginsDir, name);
    const entryPoint = resolve(pluginDir, 'index.mjs');

    if (!existsSync(entryPoint)) {
      console.warn(chalk.yellow(`  Warning: plugin '${name}' not found at ${pluginDir}/`));
      continue;
    }

    const config = loadPluginConfig(pluginDir, projectRoot, name);

    try {
      const plugin = await import(entryPoint);
      if (typeof plugin.register !== 'function') {
        console.warn(chalk.yellow(`  Warning: plugin '${name}' has no register() function`));
        continue;
      }
      plugin.register(program, { config, utils, projectRoot, devkitRoot });
    } catch (e) {
      console.error(chalk.red(`  Error loading plugin '${name}': ${e.message}`));
    }
  }

  return { projectRoot, plugins };
}

/**
 * List all available plugins in the plugins directory.
 */
export function listAvailablePlugins(devkitRoot) {
  const pluginsDir = resolve(devkitRoot, 'plugins');
  if (!existsSync(pluginsDir)) return [];

  const entries = readdirSync(pluginsDir);
  const plugins = [];

  for (const name of entries) {
    const dir = resolve(pluginsDir, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch { continue; }

    const configPath = resolve(dir, 'config.yml');
    let description = '';
    if (existsSync(configPath)) {
      const cfg = parseYaml(readFileSync(configPath, 'utf-8')) || {};
      description = cfg.description || '';
    }
    plugins.push({ name, description });
  }

  return plugins;
}
