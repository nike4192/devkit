import { run as promptRun } from './prompt.mjs';
import { run as promptWithPageRun } from './prompt-with-page.mjs';
import { run as oauthRun } from './oauth.mjs';

const providers = {
  'prompt': promptRun,
  'prompt-with-page': promptWithPageRun,
  'oauth': oauthRun,
};

export function getProvider(name) {
  const fn = providers[name || 'prompt'];
  if (!fn) throw new Error(`Unknown env-var provider: ${name}`);
  return fn;
}

/**
 * Interpolate {env:NAME} and {dot.path} placeholders.
 *
 *   {env:FOO}       → process.env.FOO
 *   {site_url}      → context.site_url
 *   {a.b.c}         → context.a.b.c
 *
 * Missing values are left as the original placeholder so the user sees what
 * was unresolved.
 */
export function interpolate(template, context = {}) {
  if (template == null) return template;
  return String(template).replace(/\{([^}]+)\}/g, (match, expr) => {
    if (expr.startsWith('env:')) {
      const key = expr.slice(4).trim();
      return process.env[key] ?? match;
    }
    const value = expr.split('.').reduce(
      (obj, key) => (obj && typeof obj === 'object' ? obj[key] : undefined),
      context,
    );
    return value == null ? match : String(value);
  });
}
