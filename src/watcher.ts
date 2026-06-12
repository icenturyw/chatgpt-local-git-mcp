import fs from 'node:fs';
import path from 'node:path';
import { inferAllowedTasks } from './config.js';
import type { AppConfig, RepoRuntime } from './types.js';

export function watchReposDir(
  config: AppConfig,
  repos: RepoRuntime[],
  onChange?: (repos: RepoRuntime[]) => void,
): fs.FSWatcher | null {
  const reposDir = config.reposDir;
  if (!reposDir) return null;

  const resolvedDir = path.resolve(reposDir);
  if (!fs.existsSync(resolvedDir)) {
    console.warn(`reposDir '${resolvedDir}' does not exist, watcher not started.`);
    return null;
  }

  const existingNames = new Set(repos.map((r) => r.name));

  function checkNewRepos() {
    let changed = false;
    const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (existingNames.has(entry.name)) continue;

      const repoPath = path.join(resolvedDir, entry.name);
      const gitDir = path.join(repoPath, '.git');
      if (!fs.existsSync(gitDir)) continue;

      const newRepo: RepoRuntime = {
        name: entry.name,
        path: repoPath,
        absPath: repoPath,
        allowedReadPaths: ['.'],
        allowedWritePaths: ['.'],
        deniedPaths: ['.git', '.env', '.env.*', 'node_modules', '__pycache__', 'secrets'],
        allowedTasks: inferAllowedTasks(repoPath),
      };

      repos.push(newRepo);
      existingNames.add(entry.name);
      console.log(`[watcher] Discovered new repo: ${entry.name} at ${repoPath}`);
      changed = true;
    }
    if (changed) onChange?.(repos);
  }

  function checkRemovedRepos() {
    let changed = false;
    for (let i = repos.length - 1; i >= 0; i--) {
      const repo = repos[i];
      if (!fs.existsSync(repo.absPath)) {
        console.log(`[watcher] Repo removed: ${repo.name}`);
        existingNames.delete(repo.name);
        repos.splice(i, 1);
        changed = true;
      }
    }
    if (changed) onChange?.(repos);
  }

  // Watch for directory changes
  const watcher = fs.watch(resolvedDir, (event, filename) => {
    if (!filename) return;
    // Small delay to ensure .git directory is fully created
    setTimeout(() => {
      checkNewRepos();
      checkRemovedRepos();
    }, 100);
  });

  watcher.on('error', (err) => {
    console.error('[watcher] Error:', err);
  });

  // Periodic check as fallback (every 5 seconds)
  const interval = setInterval(() => {
    checkNewRepos();
    checkRemovedRepos();
  }, 5000);

  // Cleanup interval when watcher is closed
  watcher.on('close', () => clearInterval(interval));

  console.log(`[watcher] Watching reposDir: ${resolvedDir}`);
  return watcher;
}
