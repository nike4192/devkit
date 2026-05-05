import { input, password } from '@inquirer/prompts';
import chalk from 'chalk';

/**
 * Simple interactive prompt provider.
 *
 * Spec fields:
 *   description — short label shown as the question text
 *   hint        — multi-line explanation printed before the prompt
 *   secret      — true → masked input via password()
 *   default     — pre-filled value
 *   validate    — regex string; non-matching answers are re-prompted
 */
export async function run({ name, spec, currentValue }) {
  if (spec.hint) {
    for (const line of String(spec.hint).split('\n')) {
      if (line.trim()) console.log(chalk.dim(`  ${line}`));
    }
  }

  const message = `${name}${spec.description ? ` — ${spec.description}` : ''}`;
  const ask = spec.secret ? password : input;

  const opts = { message, mask: spec.secret ? '*' : undefined };
  if (currentValue) opts.default = currentValue;
  else if (spec.default != null) opts.default = String(spec.default);

  if (spec.validate) {
    const re = new RegExp(spec.validate);
    opts.validate = (v) => re.test(v) || `Doesn't match ${spec.validate}`;
  }

  return await ask(opts);
}
