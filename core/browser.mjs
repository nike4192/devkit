import { spawn } from 'child_process';
import { platform } from 'os';

/**
 * Open a URL in the user's default browser. Non-blocking, fire-and-forget.
 * Returns true if the open command was spawned, false if no opener is available.
 */
export function openBrowser(url) {
  const cmd = openerCommand();
  if (!cmd) return false;

  try {
    const child = spawn(cmd.bin, [...cmd.args, url], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function openerCommand() {
  const p = platform();
  if (p === 'darwin') return { bin: 'open', args: [] };
  if (p === 'win32') return { bin: 'cmd', args: ['/c', 'start', ''] };
  // linux / freebsd / etc
  return { bin: 'xdg-open', args: [] };
}
