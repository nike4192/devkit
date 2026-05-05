import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { openBrowser } from '../browser.mjs';
import { run as runPrompt } from './prompt.mjs';

/**
 * Provider that opens a browser tab on a helper page (where the user creates
 * or finds the credential), then prompts for the value.
 *
 * Spec fields (in addition to prompt.mjs fields):
 *   open_url — URL to open in the browser. Supports {env:NAME} and {key.path}
 *              interpolation (resolved by the orchestrator before calling).
 */
export async function run({ name, spec, currentValue }) {
  const url = spec.open_url;

  if (url) {
    console.log(chalk.cyan(`  → ${url}`));
    const opened = openBrowser(url);
    if (!opened) {
      console.log(chalk.yellow('  Could not auto-open browser. Open the URL above manually.'));
    }
    // Give the user a beat to land on the page before the prompt steals focus
    await confirm({
      message: 'Press Enter when the page is open and you are ready to paste the value',
      default: true,
    });
  }

  return await runPrompt({ name, spec, currentValue });
}
