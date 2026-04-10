import * as directus from './directus.mjs';

function handleError(e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}

/**
 * Register directus plugin commands.
 * @param {import('commander').Command} program
 * @param {object} context
 */
export function register(program, { config, utils, projectRoot, devkitRoot }) {
  const ctx = { config, utils, projectRoot };

  const directusCmd = program
    .command('directus')
    .description(config.description || 'Directus CLI wrapper');

  // --- exec: run arbitrary directus CLI command ---

  directusCmd
    .command('exec <alias> [args...]')
    .description('Run a Directus CLI command inside a container (e.g. devkit directus exec inner schema snapshot)')
    .action((alias, args) => {
      try { directus.exec({ ...ctx, alias, args }); } catch (e) { handleError(e); }
    });

  // --- snapshot subcommand ---

  const snapshotCmd = directusCmd
    .command('snapshot')
    .description('Directus schema snapshots');

  snapshotCmd
    .command('ls')
    .description('Show local schema snapshots')
    .action(() => { try { directus.snapshotLs(ctx); } catch (e) { handleError(e); } });

  snapshotCmd
    .command('dump')
    .description('Export schema snapshot from Directus containers')
    .option('--type <type>', 'Type alias: inner or outer (default: all)')
    .option('--dest <dest>', 'Destination folder')
    .action(opts => directus.snapshotDump({ ...ctx, ...opts }).catch(handleError));

  snapshotCmd
    .command('load')
    .description('Apply schema snapshot to Directus container')
    .option('--type <type>', 'Type alias: inner or outer')
    .option('--date <date>', 'Snapshot date (YYYYMMDD or YYYY-MM-DD)')
    .option('--src <path>', 'Path to .json file')
    .action(opts => directus.snapshotLoad({ ...ctx, ...opts }).catch(handleError));
}
