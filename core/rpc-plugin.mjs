/**
 * JSON-RPC 2.0 stdio external plugin support.
 *
 * Spawns an external process (Python, Node, etc.), sends JSON-RPC requests
 * via stdin, reads responses from stdout. Log notifications are printed
 * to the console in real-time.
 *
 * External plugin layout:
 *   <plugin_dir>/
 *     plugin.json         # manifest with runtime, entry, tools[]
 *     <entry script>
 *
 * Manifest example:
 *   {
 *     "name": "transfers",
 *     "description": "...",
 *     "runtime": "python3",
 *     "entry": "rpc_server.py",
 *     "tools": [
 *       { "name": "list_roles", "description": "...", "params": { ... } }
 *     ]
 *   }
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import chalk from 'chalk';

export class RpcPlugin {
  constructor({ runtime, entry, cwd, quiet = false }) {
    this._runtime = runtime;
    this._entry = entry;
    this._cwd = cwd;
    this._quiet = quiet;
    this._nextId = 1;
    this._pending = new Map();
    this._process = null;
    this._rl = null;
  }

  _ensureProcess() {
    if (this._process) return;

    this._process = spawn(this._runtime, [this._entry], {
      cwd: this._cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this._rl = createInterface({ input: this._process.stdout });
    this._rl.on('line', (line) => this._handleLine(line));

    const stderrRl = createInterface({ input: this._process.stderr });
    stderrRl.on('line', (line) => {
      if (!this._quiet) {
        console.error(chalk.red(`  [plugin stderr] ${line}`));
      }
    });

    this._process.on('exit', (code) => {
      for (const [, { reject }] of this._pending) {
        reject(new Error(`Plugin process exited with code ${code}`));
      }
      this._pending.clear();
      this._process = null;
    });
  }

  _handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      if (!this._quiet) console.log(`  ${line}`);
      return;
    }

    if (msg.id === undefined || msg.id === null) {
      if (msg.method === 'log' && !this._quiet) {
        const p = msg.params || {};
        const level = p.level || 'info';
        const text = p.message || '';
        if (level === 'error') {
          console.error(chalk.red(`  ${text}`));
        } else {
          console.log(chalk.dim(`  ${text}`));
        }
      }
      return;
    }

    const pending = this._pending.get(msg.id);
    if (!pending) return;
    this._pending.delete(msg.id);

    if (msg.error) {
      pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    } else {
      pending.resolve(msg.result);
    }
  }

  call(method, params = {}, timeout = 120000) {
    this._ensureProcess();

    const id = this._nextId++;
    const request = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`RPC timeout: ${method} (${timeout}ms)`));
      }, timeout);

      this._pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      this._process.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  close() {
    if (this._process) {
      try { this._process.stdin.end(); } catch {}
      try { this._process.kill(); } catch {}
      this._process = null;
    }
  }
}

/**
 * Load an external plugin manifest (plugin.json) and create an RpcPlugin.
 */
export function loadExternalPlugin(pluginDir) {
  const manifestPath = resolve(pluginDir, 'plugin.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`plugin.json not found at ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

  const plugin = new RpcPlugin({
    runtime: manifest.runtime || 'python3',
    entry: resolve(pluginDir, manifest.entry),
    cwd: pluginDir,
  });

  return { manifest, plugin };
}

/**
 * Register a single external RPC plugin as Commander commands.
 *
 * @param {import('commander').Command} program
 * @param {string} name        — plugin name (CLI subcommand name)
 * @param {string} pluginDir   — absolute path to plugin directory
 */
export function registerRpcPlugin(program, name, pluginDir) {
  const { manifest, plugin } = loadExternalPlugin(pluginDir);

  const parentCmd = program
    .command(name)
    .description(manifest.description || name);

  for (const tool of manifest.tools || []) {
    const cmdName = tool.name.replace(/_/g, '-');
    const cmd = parentCmd
      .command(cmdName)
      .description(tool.description || '');

    for (const [paramName, paramDef] of Object.entries(tool.params || {})) {
      const flag = `--${paramName.replace(/_/g, '-')} <value>`;
      if (paramDef.required) {
        cmd.requiredOption(flag, paramDef.description);
      } else if (paramDef.type === 'boolean') {
        cmd.option(`--${paramName.replace(/_/g, '-')}`, paramDef.description);
      } else {
        cmd.option(flag, paramDef.description, paramDef.default);
      }
    }

    cmd.action(async (opts) => {
      try {
        const params = {};
        for (const [key, val] of Object.entries(opts)) {
          // Commander stores camelCase from --kebab-case → convert to snake_case
          const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
          params[snakeKey] = val;
        }

        const result = await plugin.call(tool.name, params);

        if (result && typeof result === 'object') {
          if (result.error) {
            console.error(chalk.red(`\nError: ${result.error}`));
            process.exit(1);
          }
          console.log(chalk.green('\n--- Result ---'));
          console.log(JSON.stringify(result, null, 2));
        }
      } catch (e) {
        console.error(chalk.red(`Error: ${e.message}`));
        process.exit(1);
      } finally {
        plugin.close();
      }
    });
  }

  return manifest;
}
