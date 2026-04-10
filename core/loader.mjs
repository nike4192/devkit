import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { parse as parseYaml } from 'yaml';
import chalk from 'chalk';

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
 */
function parseManifest(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
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

  for (const pluginName of plugins) {
    const pluginDir = resolve(pluginsDir, pluginName);
    const entryPoint = resolve(pluginDir, 'index.mjs');

    if (!existsSync(entryPoint)) {
      console.warn(chalk.yellow(`  Warning: plugin '${pluginName}' not found at ${pluginDir}/`));
      continue;
    }

    const config = loadPluginConfig(pluginDir, projectRoot, pluginName);

    try {
      const plugin = await import(entryPoint);
      if (typeof plugin.register !== 'function') {
        console.warn(chalk.yellow(`  Warning: plugin '${pluginName}' has no register() function`));
        continue;
      }
      plugin.register(program, { config, utils, projectRoot, devkitRoot });
    } catch (e) {
      console.error(chalk.red(`  Error loading plugin '${pluginName}': ${e.message}`));
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
