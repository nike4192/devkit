#!/usr/bin/env node

import { Command } from 'commander';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'fs';
import chalk from 'chalk';
import { parse as parseYaml } from 'yaml';
import { loadPlugins, findProject, listAvailablePlugins } from './core/loader.mjs';
import * as utils from './core/utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const devkitRoot = __dirname;

const program = new Command();

program
  .name('devkit')
  .description('Plugin-based CLI toolkit for project infrastructure management')
  .version('2.0.0');

// --- Core commands (always available) ---

program
  .command('plugins')
  .description('List available plugins')
  .action(() => {
    const available = listAvailablePlugins(devkitRoot);

    console.log(chalk.bold('\nAvailable plugins:\n'));
    for (const p of available) {
      console.log(`  ${chalk.cyan(p.name)}  ${chalk.dim(p.description)}`);
    }

    try {
      const { plugins } = findProject();
      console.log(chalk.bold('\nEnabled in this project:\n'));
      for (const entry of plugins) {
        const { name, path: extPath } = entry;
        if (extPath) {
          console.log(`  ${chalk.cyan('\u279c')} ${name} ${chalk.dim(`(external: ${extPath})`)}`);
        } else {
          const isAvailable = available.some(a => a.name === name);
          const status = isAvailable ? chalk.green('\u2713') : chalk.red('\u2717 not found');
          console.log(`  ${status} ${name}`);
        }
      }
    } catch {
      console.log(chalk.dim('\n  No .devkit manifest found in current directory tree.'));
    }
    console.log();
  });

program
  .command('init')
  .description('Create .devkit manifest and .devkit.d/ config directory')
  .action(async () => {
    const cwd = process.cwd();
    const manifestPath = resolve(cwd, '.devkit');
    const configDir = resolve(cwd, '.devkit.d');

    if (existsSync(manifestPath)) {
      console.log(chalk.yellow('.devkit already exists.'));
    } else {
      const available = listAvailablePlugins(devkitRoot);
      const pluginList = available.map(p => `# ${p.name}`).join('\n');
      const { writeFileSync } = await import('fs');
      writeFileSync(manifestPath, `# Enabled devkit plugins (one per line)\n${pluginList}\n`);
      console.log(chalk.green('Created .devkit'));
    }

    if (!existsSync(configDir)) {
      mkdirSync(configDir);
      console.log(chalk.green('Created .devkit.d/'));
    }

    console.log(chalk.dim('\nEdit .devkit to uncomment the plugins you need.'));
    console.log(chalk.dim('Add plugin overrides in .devkit.d/{plugin}.yml'));
  });

program
  .command('setup')
  .description('Full project setup: env files, Docker networks, required directories')
  .option('--env-name <env>', 'Infisical environment', 'dev')
  .option('--force', 'Overwrite existing .env files')
  .action(async (opts) => {
    try {
      const { projectRoot, plugins } = findProject();
      const enabledNames = plugins.map(p => p.name);

      // 1. env init (if env plugin is enabled)
      if (enabledNames.includes('env')) {
        console.log(chalk.bold('\n=== Initializing .env files ==='));
        const pluginDir = resolve(devkitRoot, 'plugins', 'env');
        const configPath = resolve(pluginDir, 'config.yml');
        let config = {};
        if (existsSync(configPath)) {
          config = parseYaml(readFileSync(configPath, 'utf-8')) || {};
        }
        const overridePath = resolve(projectRoot, '.devkit.d', 'env.yml');
        if (existsSync(overridePath)) {
          const { deepMerge } = await import('./core/loader.mjs');
          const overrides = parseYaml(readFileSync(overridePath, 'utf-8')) || {};
          config = deepMerge(config, overrides);
        }

        const envModule = await import('./plugins/env/env.mjs');
        await envModule.init({
          config, utils, projectRoot,
          envName: opts.envName, force: opts.force,
        });
      }

      // 2. Docker networks (if docker plugin is enabled)
      if (enabledNames.includes('docker')) {
        console.log(chalk.bold('\n=== Docker networks ==='));
        const pluginDir = resolve(devkitRoot, 'plugins', 'docker');
        const configPath = resolve(pluginDir, 'config.yml');
        let config = {};
        if (existsSync(configPath)) {
          config = parseYaml(readFileSync(configPath, 'utf-8')) || {};
        }
        const overridePath = resolve(projectRoot, '.devkit.d', 'docker.yml');
        if (existsSync(overridePath)) {
          const { deepMerge } = await import('./core/loader.mjs');
          const overrides = parseYaml(readFileSync(overridePath, 'utf-8')) || {};
          config = deepMerge(config, overrides);
        }

        const composeFile = config.compose_file || 'docker-compose.dev.yml';
        const networks = utils.getComposeExternalNetworks(projectRoot, composeFile);
        if (networks.length === 0) {
          console.log('  No external networks found.');
        } else {
          const created = utils.ensureDockerNetworks(projectRoot, composeFile);
          for (const net of networks) {
            if (created.includes(net)) {
              console.log(chalk.green(`  Created network: ${net}`));
            } else {
              console.log(`  Network exists: ${net}`);
            }
          }
        }
      }

      // 3. Upload directories
      console.log(chalk.bold('\n=== Directories ==='));
      const dirs = ['apps/inner/uploads', 'apps/outer/uploads'];
      for (const dir of dirs) {
        const fullPath = resolve(projectRoot, dir);
        if (!existsSync(fullPath)) {
          mkdirSync(fullPath, { recursive: true });
          console.log(chalk.green(`  Created: ${dir}`));
        } else {
          console.log(`  Exists: ${dir}`);
        }
      }

      console.log(chalk.green('\n\u2713 Project ready'));
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  });

// --- Load plugins dynamically ---

try {
  await loadPlugins(program, utils, devkitRoot);
} catch (e) {
  // If no .devkit found, still allow core commands (plugins, init)
  if (!process.argv.slice(2).some(a => ['plugins', 'init', '--help', '-h', '--version', '-V'].includes(a))) {
    console.error(chalk.red(e.message));
    process.exit(1);
  }
}

program.parse();
