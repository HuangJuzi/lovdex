import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * 文件树要跳过的「被 git 忽略的目录」的绝对路径集合。
 *
 * 构建/缓存产物（node_modules、dist、.ci-cache 之类）经常占掉整棵树九成以上的节点：
 * 实测某个项目 49,281 个节点里有 47,889 个来自一个被忽略的 CI 缓存目录，整个
 * `/files` 请求要 2.9s、返回 21MB JSON，而浏览器里这些节点毫无用处。
 *
 * 与其往 IGNORED_DIRS 里一条条加名字，不如让 git 自己判断：一次 `ls-files
 * --others --ignored --directory` 就拿到全部「整目录被忽略」的路径（.gitignore、
 * 嵌套 .gitignore、.git/info/exclude 的规则都由 git 处理，无需自己解析）。
 *
 * 目录不是 git 仓库、或环境里没有 git 时返回空集合，调用方退回 IGNORED_DIRS 那套
 * 硬编码规则，行为与改动前一致。
 */
export function listGitIgnoredDirPaths(rootPath: string): Set<string> {
  try {
    const stdout = execFileSync(
      'git',
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      {
        cwd: rootPath,
        encoding: 'utf8',
        // git 的诊断信息不需要，也不该混进结果里。
        stdio: ['ignore', 'pipe', 'ignore'],
        // 默认 1MB 对大型仓库不够；被忽略的单个文件也会列进来。
        maxBuffer: 64 * 1024 * 1024,
      },
    );

    return new Set(
      stdout
        .split('\0')
        .filter(Boolean)
        // `--directory` 给出的目录条目通常带结尾斜杠，但并非总是如此，两种都接住。
        .map((relativePath) => path.resolve(rootPath, relativePath.replace(/\/+$/, ''))),
    );
  } catch {
    return new Set();
  }
}
