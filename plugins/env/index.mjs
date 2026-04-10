import * as env from './env.mjs';
import * as infisical from './infisical.mjs';

function handleError(e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}

/**
 * Register env plugin commands.
 * @param {import('commander').Command} program
 * @param {object} context
 */
export function register(program, { config, utils, projectRoot, devkitRoot }) {
  const envCmd = program
    .command('env')
    .description(config.description || 'Manage .env files');

  envCmd
    .command('status')
    .description('Show .env file status')
    .action(() => env.status({ config, utils, projectRoot }).catch(handleError));

  envCmd
    .command('init')
    .description('Initialize .env from examples + Infisical secrets')
    .option('--env-name <env>', 'Infisical environment', 'dev')
    .option('--force', 'Overwrite existing .env')
    .action(opts => env.init({
      config, utils, projectRoot,
      envName: opts.envName, force: opts.force,
    }).catch(handleError));

  envCmd
    .command('pull-secrets')
    .description('Update only secrets in .env files')
    .option('--env-name <env>', 'Infisical environment', 'dev')
    .action(opts => env.pullSecrets({
      config, utils, projectRoot,
      envName: opts.envName,
    }).catch(handleError));

  // --- infisical subcommand ---

  const infisicalCmd = envCmd
    .command('infisical')
    .description('Manage Infisical secrets');

  infisicalCmd
    .command('list')
    .description('List secrets')
    .option('--env <env>', 'Environment', 'dev')
    .option('--path <path>', 'Secret path', '/')
    .action(opts => infisical.list({
      config, utils, env: opts.env, path: opts.path,
    }).catch(handleError));

  infisicalCmd
    .command('get <name>')
    .description('Get secret value')
    .option('--env <env>', 'Environment', 'dev')
    .option('--path <path>', 'Secret path', '/')
    .action((name, opts) => infisical.get({
      config, utils, name, env: opts.env, path: opts.path,
    }).catch(handleError));

  infisicalCmd
    .command('set <keyValue>')
    .description('Set secret (KEY=VALUE)')
    .option('--env <env>', 'Environment', 'dev')
    .option('--path <path>', 'Secret path', '/')
    .action((kv, opts) => infisical.set({
      config, utils, keyValue: kv, env: opts.env, path: opts.path,
    }).catch(handleError));

  infisicalCmd
    .command('delete <name>')
    .description('Delete secret')
    .option('--env <env>', 'Environment', 'dev')
    .option('--path <path>', 'Secret path', '/')
    .action((name, opts) => infisical.del({
      config, utils, name, env: opts.env, path: opts.path,
    }).catch(handleError));

  infisicalCmd
    .command('deploy')
    .description('Deploy secrets to server')
    .requiredOption('--env <env>', 'Environment (test or stage)')
    .option('--yes, -y', 'Skip confirmation')
    .action(opts => infisical.deploy({
      config, utils, env: opts.env, yes: opts.yes,
    }).catch(handleError));
}
