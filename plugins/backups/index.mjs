import * as backups from './backups.mjs';

function handleError(e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}

/**
 * Register backups plugin commands.
 * @param {import('commander').Command} program
 * @param {object} context
 */
export function register(program, { config, utils, projectRoot, devkitRoot }) {
  const ctx = { config, utils, projectRoot };
  const backupsCmd = program.command('backups').description(config.description || 'Database backups');

  backupsCmd
    .command('ls')
    .description('Show local dumps (downloaded and created)')
    .action(() => { try { backups.ls(ctx); } catch (e) { handleError(e); } });

  backupsCmd
    .command('list')
    .description('Show available dumps on server')
    .option('--env <env>', 'Environment: test or stage', 'test')
    .option('--source <source>', 'Source: all, server, yadisk', 'all')
    .action(opts => backups.list({ ...ctx, ...opts }).catch(handleError));

  backupsCmd
    .command('pull')
    .description('Download dumps')
    .option('--env <env>', 'Environment: test, stage or local', 'test')
    .option('--type <type>', 'Type: inner or outer')
    .option('--date <date>', 'Dump date (YYYY-MM-DD)')
    .option('--source <source>', 'Source: auto, server, yadisk', 'auto')
    .option('--dest <dest>', 'Destination folder', 'backups')
    .action(opts => backups.pull({ ...ctx, ...opts }).catch(handleError));

  backupsCmd
    .command('dump')
    .description('Create a local DB dump')
    .option('--type <type>', 'Type: inner or outer (default: both)')
    .option('--dest <dest>', 'Destination folder', 'backups')
    .action(opts => backups.dump({ ...ctx, ...opts }).catch(handleError));

  backupsCmd
    .command('load')
    .description('Restore a dump into a local container')
    .option('--type <type>', 'Type: inner or outer')
    .option('--date <date>', 'Dump date (YYYY-MM-DD)')
    .option('--src <path>', 'Path to .sql.gz file')
    .action(opts => backups.load({ ...ctx, ...opts }).catch(handleError));
}
