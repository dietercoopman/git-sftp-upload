import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import SftpClient from 'ssh2-sftp-client';
import { parse as parseJsonc, ParseError, printParseErrorCode } from 'jsonc-parser';

/** Subset of the sftp.json format used by the SFTP extension (Natizyskunk / liximomo). */
interface SftpConfig {
  name?: string;
  protocol?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string | boolean;
  privateKeyPath?: string;
  passphrase?: string | boolean;
  agent?: string;
  remotePath?: string;
  context?: string;
  connectTimeout?: number;
  profiles?: Record<string, Partial<SftpConfig>>;
  defaultProfile?: string;
}

interface ResolvedConfig {
  key: string;
  label: string;
  folder: vscode.WorkspaceFolder;
  contextPath: string;
  remotePath: string;
  settings: SftpConfig;
}

interface FileJob {
  localPath: string;
  remotePath: string;
  display: string;
}

interface RunCache {
  raw: Map<string, unknown>;
  profiles: Map<string, string>;
  warnedPlaintext: Set<string>;
}

class CancelledError extends Error {
  constructor() {
    super('Cancelled');
  }
}

const output = vscode.window.createOutputChannel('Git SFTP Upload');
let extensionContext: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  const tree = new ChangesTreeProvider();
  const view = vscode.window.createTreeView('gitSftpUpload.changes', {
    treeDataProvider: tree,
    canSelectMany: true,
    showCollapseAll: false,
  });
  context.subscriptions.push(
    output,
    view,
    tree,
    vscode.commands.registerCommand('gitSftpUpload.uploadResources', (...args: unknown[]) =>
      uploadUris(collectUrisFromArgs(args))
    ),
    vscode.commands.registerCommand('gitSftpUpload.uploadGroup', (...args: unknown[]) =>
      uploadUris(collectUrisFromArgs(args))
    ),
    vscode.commands.registerCommand('gitSftpUpload.uploadAllChanged', async () =>
      uploadUris(await collectAllChangedUris())
    ),
    vscode.commands.registerCommand('gitSftpUpload.uploadAllFromView', async () =>
      uploadUris(await collectAllChangedUris())
    ),
    vscode.commands.registerCommand('gitSftpUpload.uploadFromView', (node?: TreeNode, selected?: TreeNode[]) => {
      // VS Code passes the clicked node plus the current multi-selection.
      const nodes = selected?.length ? selected : node ? [node] : [...view.selection];
      uploadUris(tree.urisFor(nodes));
    }),
    vscode.commands.registerCommand('gitSftpUpload.refreshView', () => tree.refresh()),
    vscode.commands.registerCommand('gitSftpUpload.openFile', (node?: TreeNode) => {
      if (node?.kind === 'file') vscode.commands.executeCommand('vscode.open', node.uri);
    }),
    vscode.commands.registerCommand('gitSftpUpload.openChanges', (node?: TreeNode) => {
      if (node?.kind === 'file') vscode.commands.executeCommand('git.openChange', node.uri);
    }),
    vscode.commands.registerCommand('gitSftpUpload.forgetTrustedHostKeys', forgetTrustedHostKeys)
  );
  void tree.start();
}

export function deactivate() {}

// ---------------------------------------------------------------------------
// Collecting files
// ---------------------------------------------------------------------------

/** Extracts URIs from what VS Code passes in: resource states (including multi-select) or whole groups. */
function collectUrisFromArgs(args: unknown[]): vscode.Uri[] {
  const result = new Map<string, vscode.Uri>();
  const walk = (value: unknown) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value instanceof vscode.Uri) {
      result.set(value.toString(), value);
    } else if (typeof value === 'object') {
      const v = value as { resourceUri?: vscode.Uri; resourceStates?: unknown[] };
      if (v.resourceStates) walk(v.resourceStates);
      else if (v.resourceUri) walk(v.resourceUri);
    }
  };
  walk(args);

  if (result.size === 0 && vscode.window.activeTextEditor) {
    const uri = vscode.window.activeTextEditor.document.uri;
    result.set(uri.toString(), uri);
  }
  return [...result.values()];
}

// Minimal typing of the built-in git extension API (vscode.git, API version 1).
interface GitChange {
  uri: vscode.Uri;
  originalUri: vscode.Uri;
  status: number;
}
interface GitRepository {
  rootUri: vscode.Uri;
  state: {
    indexChanges: GitChange[];
    workingTreeChanges: GitChange[];
    untrackedChanges?: GitChange[];
    onDidChange: vscode.Event<void>;
  };
}
interface GitApi {
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
  onDidCloseRepository: vscode.Event<GitRepository>;
}

let gitApiPromise: Promise<GitApi | undefined> | undefined;

async function getGitApi(): Promise<GitApi | undefined> {
  if (!gitApiPromise) {
    gitApiPromise = (async () => {
      const gitExt = vscode.extensions.getExtension<any>('vscode.git');
      if (!gitExt) return undefined;
      const exports = gitExt.isActive ? gitExt.exports : await gitExt.activate();
      return exports.getAPI(1) as GitApi;
    })();
  }
  return gitApiPromise;
}

function repoChanges(repo: GitRepository): GitChange[] {
  // Untracked files are listed separately only when git.untrackedChanges is "separate".
  return [
    ...(repo.state.indexChanges ?? []),
    ...(repo.state.workingTreeChanges ?? []),
    ...(repo.state.untrackedChanges ?? []),
  ];
}

/** All staged, modified and untracked files from all git repositories. */
async function collectAllChangedUris(): Promise<vscode.Uri[]> {
  const git = await getGitApi();
  if (!git) {
    vscode.window.showErrorMessage('The built-in Git extension is not available.');
    return [];
  }
  const result = new Map<string, vscode.Uri>();
  for (const repo of git.repositories) {
    for (const change of repoChanges(repo)) {
      result.set(change.uri.toString(), change.uri);
    }
  }
  return [...result.values()];
}

// ---------------------------------------------------------------------------
// Activity bar view: changed files
// ---------------------------------------------------------------------------

/** Status values of the git extension API. */
const enum GitStatus {
  INDEX_MODIFIED = 0,
  INDEX_ADDED = 1,
  INDEX_DELETED = 2,
  INDEX_RENAMED = 3,
  INDEX_COPIED = 4,
  MODIFIED = 5,
  DELETED = 6,
  UNTRACKED = 7,
  IGNORED = 8,
  INTENT_TO_ADD = 9,
  INTENT_TO_RENAME = 10,
  TYPE_CHANGED = 11,
}

const STATUS_LABEL: Record<number, [letter: string, text: string]> = {
  [GitStatus.INDEX_MODIFIED]: ['M', 'Modified (staged)'],
  [GitStatus.INDEX_ADDED]: ['A', 'Added (staged)'],
  [GitStatus.INDEX_DELETED]: ['D', 'Deleted (staged)'],
  [GitStatus.INDEX_RENAMED]: ['R', 'Renamed (staged)'],
  [GitStatus.INDEX_COPIED]: ['C', 'Copied (staged)'],
  [GitStatus.MODIFIED]: ['M', 'Modified'],
  [GitStatus.DELETED]: ['D', 'Deleted'],
  [GitStatus.UNTRACKED]: ['U', 'Untracked'],
  [GitStatus.INTENT_TO_ADD]: ['A', 'Intent to add'],
  [GitStatus.INTENT_TO_RENAME]: ['R', 'Intent to rename'],
  [GitStatus.TYPE_CHANGED]: ['T', 'Type changed'],
};

type TreeNode =
  | { kind: 'group'; id: string; label: string; files: FileNode[] }
  | FileNode;

interface FileNode {
  kind: 'file';
  uri: vscode.Uri;
  status: number;
  repo: GitRepository;
}

class ChangesTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly repoListeners = new Map<GitRepository, vscode.Disposable>();
  private refreshTimer: NodeJS.Timeout | undefined;

  async start(): Promise<void> {
    const git = await getGitApi();
    await vscode.commands.executeCommand('setContext', 'gitSftpUpload.gitAvailable', !!git);
    if (!git) return;
    git.repositories.forEach((r) => this.watch(r));
    this.disposables.push(
      git.onDidOpenRepository((r) => {
        this.watch(r);
        this.refresh();
      }),
      git.onDidCloseRepository((r) => {
        this.repoListeners.get(r)?.dispose();
        this.repoListeners.delete(r);
        this.refresh();
      })
    );
    this.refresh();
  }

  private watch(repo: GitRepository) {
    if (this.repoListeners.has(repo)) return;
    this.repoListeners.set(repo, repo.state.onDidChange(() => this.refresh()));
  }

  /** Debounced: git fires several state changes in a row. */
  refresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.emitter.fire(undefined), 150);
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (node) return node.kind === 'group' ? node.files : [];
    const git = await getGitApi();
    if (!git) return [];

    const staged: FileNode[] = [];
    const changes: FileNode[] = [];
    const untracked: FileNode[] = [];
    const seen = new Set<string>();
    for (const repo of git.repositories) {
      for (const change of repoChanges(repo)) {
        const key = `${change.status}:${change.uri.toString()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const file: FileNode = { kind: 'file', uri: change.uri, status: change.status, repo };
        if (change.status <= GitStatus.INDEX_COPIED) staged.push(file);
        else if (change.status === GitStatus.UNTRACKED) untracked.push(file);
        else changes.push(file);
      }
    }
    const byPath = (a: FileNode, b: FileNode) => a.uri.fsPath.localeCompare(b.uri.fsPath);
    const groups: TreeNode[] = [];
    if (staged.length) groups.push({ kind: 'group', id: 'staged', label: 'Staged Changes', files: staged.sort(byPath) });
    if (changes.length) groups.push({ kind: 'group', id: 'changes', label: 'Changes', files: changes.sort(byPath) });
    if (untracked.length) groups.push({ kind: 'group', id: 'untracked', label: 'Untracked Files', files: untracked.sort(byPath) });
    return groups;
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `group:${node.id}`;
      item.description = `${node.files.length}`;
      item.contextValue = 'group';
      item.tooltip = `${node.files.length} file(s) — click the cloud icon to upload them all`;
      return item;
    }
    const item = new vscode.TreeItem(node.uri, vscode.TreeItemCollapsibleState.None);
    const [, text] = STATUS_LABEL[node.status] ?? ['?', 'Changed'];
    const rel = path.relative(node.repo.rootUri.fsPath, node.uri.fsPath).split(path.sep).join('/');
    const dir = path.posix.dirname(rel);
    item.id = `file:${node.status}:${node.uri.toString()}`;
    // VS Code adds the git status letter and colour itself via the resourceUri decoration.
    item.description = dir === '.' ? '' : dir;
    item.tooltip = `${rel}\n${text}`;
    item.contextValue = 'file';
    const hasDiff = node.status !== GitStatus.UNTRACKED && node.status !== GitStatus.INDEX_ADDED;
    item.command = hasDiff
      ? { command: 'gitSftpUpload.openChanges', title: 'Open Changes', arguments: [node] }
      : { command: 'gitSftpUpload.openFile', title: 'Open File', arguments: [node] };
    return item;
  }

  /** Files behind a selection of tree nodes, groups expanded, duplicates removed. */
  urisFor(nodes: TreeNode[]): vscode.Uri[] {
    const result = new Map<string, vscode.Uri>();
    for (const node of nodes) {
      const files = node.kind === 'group' ? node.files : [node];
      files.forEach((f) => result.set(f.uri.toString(), f.uri));
    }
    return [...result.values()];
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.repoListeners.forEach((d) => d.dispose());
    this.disposables.forEach((d) => d.dispose());
    this.emitter.dispose();
  }
}

// ---------------------------------------------------------------------------
// Config (sftp.json)
// ---------------------------------------------------------------------------

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function loadConfig(
  folder: vscode.WorkspaceFolder,
  filePath: string,
  cache: RunCache
): Promise<ResolvedConfig> {
  const relConfig = vscode.workspace
    .getConfiguration('gitSftpUpload', folder.uri)
    .get<string>('configFile', '.vscode/sftp.json');
  const cfgPath = path.resolve(folder.uri.fsPath, relConfig);
  // The config file must live inside the workspace folder; never read arbitrary files on disk.
  if (!isInside(folder.uri.fsPath, cfgPath)) {
    throw new Error(`gitSftpUpload.configFile must point inside the workspace folder "${folder.name}"`);
  }

  let raw = cache.raw.get(cfgPath);
  if (raw === undefined) {
    if (!fs.existsSync(cfgPath)) {
      throw new Error(`No ${relConfig} found in "${folder.name}"`);
    }
    const errors: ParseError[] = [];
    raw = parseJsonc(fs.readFileSync(cfgPath, 'utf8'), errors, { allowTrailingComma: true });
    if (errors.length) {
      throw new Error(
        `Invalid JSON in ${relConfig}: ${printParseErrorCode(errors[0].error)} (position ${errors[0].offset})`
      );
    }
    cache.raw.set(cfgPath, raw);
  }

  // sftp.json may be a single object or an array of configs (each with its own "context").
  const entries = (Array.isArray(raw) ? raw : [raw]) as SftpConfig[];
  let best: SftpConfig | undefined;
  let bestIndex = -1;
  let bestContext = '';
  entries.forEach((entry, index) => {
    const ctx = path.resolve(folder.uri.fsPath, entry.context ?? '.');
    if (isInside(ctx, filePath) && ctx.length > bestContext.length) {
      best = entry;
      bestIndex = index;
      bestContext = ctx;
    }
  });
  if (!best) {
    throw new Error(`Outside every "context" in ${relConfig}`);
  }

  let settings: SftpConfig = { ...best };
  let profileName: string | undefined;
  const profiles = best.profiles ?? {};
  const profileNames = Object.keys(profiles);
  if (profileNames.length) {
    const profileKey = `${cfgPath}#${bestIndex}`;
    profileName = cache.profiles.get(profileKey);
    if (profileName === undefined) {
      if (best.defaultProfile && profiles[best.defaultProfile]) {
        profileName = best.defaultProfile;
      } else {
        const BASE = '(base configuration, no profile)';
        const choices = best.host ? [...profileNames, BASE] : profileNames;
        const picked =
          choices.length === 1
            ? choices[0]
            : await vscode.window.showQuickPick(choices, {
                placeHolder: `Choose an SFTP profile for ${best.name ?? folder.name}`,
              });
        if (!picked) throw new CancelledError();
        profileName = picked === BASE ? '' : picked;
      }
      cache.profiles.set(profileKey, profileName);
    }
    if (profileName) settings = { ...settings, ...profiles[profileName] };
  }

  if (settings.protocol && settings.protocol !== 'sftp') {
    throw new Error(`Protocol "${settings.protocol}" is not supported, only sftp`);
  }
  if (!settings.host) throw new Error(`No "host" set in ${relConfig}`);
  if (!settings.remotePath) throw new Error(`No "remotePath" set in ${relConfig}`);

  if (
    (typeof settings.password === 'string' || typeof settings.passphrase === 'string') &&
    !cache.warnedPlaintext.has(cfgPath)
  ) {
    cache.warnedPlaintext.add(cfgPath);
    output.appendLine(
      `WARNING: ${relConfig} contains a plaintext password or passphrase. ` +
        `Use "password": true to be prompted instead, and keep this file out of version control.`
    );
  }

  const label =
    `${settings.username ? settings.username + '@' : ''}${settings.host}` +
    (profileName ? ` (${profileName})` : '');

  return {
    key: `${cfgPath}#${bestIndex}#${profileName ?? ''}`,
    label,
    folder,
    contextPath: bestContext,
    remotePath: settings.remotePath,
    settings,
  };
}

async function ask(prompt: string): Promise<string> {
  const value = await vscode.window.showInputBox({ prompt, password: true, ignoreFocusOut: true });
  if (value === undefined) throw new CancelledError();
  return value;
}

async function buildConnectOptions(c: SftpConfig): Promise<SftpClient.ConnectOptions> {
  const opts: SftpClient.ConnectOptions = {
    host: c.host,
    port: c.port ?? 22,
    username: c.username,
    readyTimeout: c.connectTimeout ?? 20000,
    // No automatic retries: a rejected host key or wrong password must fail immediately,
    // otherwise ssh2-sftp-client waits 25 seconds before trying again.
    retries: 0,
  };

  if (c.privateKeyPath) {
    const keyPath = c.privateKeyPath.replace(/^~(?=$|[\/\\])/, os.homedir());
    opts.privateKey = fs.readFileSync(keyPath);
    if (c.passphrase === true) opts.passphrase = await ask(`Passphrase for ${keyPath}`);
    else if (typeof c.passphrase === 'string') opts.passphrase = c.passphrase;
  }

  if (c.password === true) opts.password = await ask(`Password for ${c.username}@${c.host}`);
  else if (typeof c.password === 'string') opts.password = c.password;

  const agent = c.agent ?? process.env.SSH_AUTH_SOCK;
  if (agent && !opts.privateKey && !opts.password) opts.agent = agent;

  if (!opts.privateKey && !opts.password && !opts.agent) {
    opts.password = await ask(`Password for ${c.username}@${c.host}`);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Host key verification
// ---------------------------------------------------------------------------

const TRUSTED_HOST_KEYS = 'trustedHostKeys';

interface HostCheckState {
  /** Set when the presented key contradicts known_hosts or a previously trusted key. */
  mismatch?: string;
  /** Set when the host is not known anywhere yet (trust-on-first-use prompt needed). */
  unknown?: { pattern: string; id: string };
}

/** Key type as encoded at the start of the SSH public key blob, e.g. "ssh-ed25519". */
function keyType(key: Buffer): string {
  const len = key.readUInt32BE(0);
  return key.subarray(4, 4 + len).toString('utf8');
}

function fingerprint(key: Buffer): string {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

/** Host as written in known_hosts: plain for port 22, "[host]:port" otherwise. */
function hostPattern(host: string, port: number): string {
  const h = host.toLowerCase();
  return port === 22 ? h : `[${h}]:${port}`;
}

function globMatch(glob: string, value: string): boolean {
  const re = glob
    .toLowerCase()
    .split('')
    .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${re}$`).test(value);
}

/** Matches one known_hosts host field (plain, wildcard, negated or hashed) against the pattern. */
function hostFieldMatches(field: string, pattern: string): boolean {
  if (field.startsWith('|1|')) {
    const [, , salt, hash] = field.split('|');
    if (!salt || !hash) return false;
    const digest = crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(pattern).digest('base64');
    return digest === hash;
  }
  let matched = false;
  for (const entry of field.split(',')) {
    if (entry.startsWith('!')) {
      if (globMatch(entry.slice(1), pattern)) return false;
    } else if (globMatch(entry, pattern)) {
      matched = true;
    }
  }
  return matched;
}

type KnownHostsResult = 'match' | 'mismatch' | 'unknown';

function checkKnownHosts(pattern: string, key: Buffer): KnownHostsResult {
  let text: string;
  try {
    text = fs.readFileSync(path.join(os.homedir(), '.ssh', 'known_hosts'), 'utf8');
  } catch {
    return 'unknown';
  }
  const type = keyType(key);
  let sawHost = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const marker = parts[0].startsWith('@') ? parts.shift() : undefined;
    if (parts.length < 3) continue;
    const [hosts, ktype, b64] = parts;
    if (marker === '@cert-authority') continue;
    if (!hostFieldMatches(hosts, pattern) || ktype !== type) continue;
    sawHost = true;
    if (Buffer.from(b64, 'base64').equals(key)) {
      return marker === '@revoked' ? 'mismatch' : 'match';
    }
  }
  return sawHost ? 'mismatch' : 'unknown';
}

function trustedHostKeys(): Record<string, string> {
  return extensionContext.globalState.get<Record<string, string>>(TRUSTED_HOST_KEYS, {});
}

/** Synchronous ssh2 host verifier: accepts only keys found in known_hosts or trusted earlier. */
function checkHostKey(host: string, port: number, key: Buffer, state: HostCheckState): boolean {
  const pattern = hostPattern(host, port);
  const id = `${keyType(key)} ${fingerprint(key)}`;
  const known = checkKnownHosts(pattern, key);
  if (known === 'match') return true;
  if (known === 'mismatch') {
    state.mismatch =
      `HOST KEY MISMATCH for ${pattern}: the server presented ${id}, which does not match ` +
      `~/.ssh/known_hosts. Possible man-in-the-middle attack. Connection refused.`;
    return false;
  }
  const trusted = trustedHostKeys()[pattern];
  if (trusted === id) return true;
  if (trusted) {
    state.mismatch =
      `HOST KEY MISMATCH for ${pattern}: the server presented ${id}, but ${trusted} was trusted earlier. ` +
      `Possible man-in-the-middle attack. Connection refused. ` +
      `Run "Git SFTP: Forget Trusted Host Keys" if the server key was changed on purpose.`;
    return false;
  }
  state.unknown = { pattern, id };
  return false;
}

async function confirmNewHostKey(pattern: string, id: string): Promise<void> {
  const TRUST = 'Trust and connect';
  const choice = await vscode.window.showWarningMessage(
    `The authenticity of host "${pattern}" can't be established.`,
    {
      modal: true,
      detail:
        `Key fingerprint:\n${id}\n\n` +
        `Verify this fingerprint with your server administrator before continuing. ` +
        `If you trust it, it is remembered for future connections.`,
    },
    TRUST
  );
  if (choice !== TRUST) throw new CancelledError();
  await extensionContext.globalState.update(TRUSTED_HOST_KEYS, { ...trustedHostKeys(), [pattern]: id });
  output.appendLine(`Trusted new host key for ${pattern}: ${id}`);
}

async function forgetTrustedHostKeys(): Promise<void> {
  const keys = Object.keys(trustedHostKeys());
  if (!keys.length) {
    vscode.window.showInformationMessage('No trusted host keys stored.');
    return;
  }
  const picked = await vscode.window.showQuickPick(keys, {
    canPickMany: true,
    placeHolder: 'Select the hosts whose trusted key should be forgotten',
  });
  if (!picked?.length) return;
  const remaining = { ...trustedHostKeys() };
  picked.forEach((k) => delete remaining[k]);
  await extensionContext.globalState.update(TRUSTED_HOST_KEYS, remaining);
  vscode.window.showInformationMessage(`Forgot host key for ${picked.join(', ')}.`);
}

/** Connects with host key verification; on an unknown host asks the user once and retries. */
async function connectVerified(c: SftpConfig): Promise<SftpClient> {
  const opts = await buildConnectOptions(c);
  const host = c.host!;
  const port = opts.port ?? 22;
  for (let attempt = 0; ; attempt++) {
    const state: HostCheckState = {};
    opts.hostVerifier = (key: Buffer) => checkHostKey(host, port, key, state);
    const client = new SftpClient();
    try {
      await client.connect(opts);
      return client;
    } catch (e) {
      await client.end().catch(() => undefined);
      if (state.mismatch) throw new Error(state.mismatch);
      if (state.unknown && attempt === 0) {
        await confirmNewHostKey(state.unknown.pattern, state.unknown.id);
        continue;
      }
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** lstat, so symbolic links are reported as links instead of being followed. */
async function lstatSafe(p: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.lstat(p);
  } catch {
    return undefined;
  }
}

function isSymlinkSync(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

async function uploadUris(uris: vscode.Uri[]) {
  if (!uris.length) {
    vscode.window.showInformationMessage('No files to upload.');
    return;
  }

  const cache: RunCache = { raw: new Map(), profiles: new Map(), warnedPlaintext: new Set() };
  const jobs = new Map<string, { config: ResolvedConfig; files: FileJob[] }>();
  const failed: string[] = [];

  // 1. Map each file to a config and remote path
  for (const uri of uris) {
    const display = vscode.workspace.asRelativePath(uri);
    if (uri.scheme !== 'file') {
      failed.push(`${display}: not a local file`);
      continue;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      failed.push(`${display}: not inside an open workspace folder`);
      continue;
    }
    let config: ResolvedConfig;
    try {
      config = await loadConfig(folder, uri.fsPath, cache);
    } catch (e) {
      if (e instanceof CancelledError) return;
      failed.push(`${display}: ${errorMessage(e)}`);
      continue;
    }
    const rel = path.relative(config.contextPath, uri.fsPath).split(path.sep).join('/');
    const job = jobs.get(config.key) ?? { config, files: [] };
    job.files.push({
      localPath: uri.fsPath,
      remotePath: path.posix.join(config.remotePath, rel),
      display,
    });
    jobs.set(config.key, job);
  }

  const total = [...jobs.values()].reduce((n, j) => n + j.files.length, 0);
  let uploaded = 0;
  let deleted = 0;
  const skipped: string[] = [];
  let cancelled = false;

  output.appendLine(`\n[${new Date().toLocaleTimeString()}] Upload of ${total} file(s) started`);

  // 2. One connection per server, all files over it
  if (total > 0) {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'SFTP upload', cancellable: true },
      async (progress, token) => {
        for (const { config, files } of jobs.values()) {
          if (token.isCancellationRequested || cancelled) break;
          const deleteRemote = vscode.workspace
            .getConfiguration('gitSftpUpload', config.folder.uri)
            .get<boolean>('deleteRemoteOnDelete', false);

          let client: SftpClient;
          try {
            progress.report({ message: `Connecting to ${config.label}…` });
            output.appendLine(`Connecting to ${config.label}`);
            client = await connectVerified(config.settings);
          } catch (e) {
            if (e instanceof CancelledError) {
              cancelled = true;
              break;
            }
            const msg = `Connection to ${config.label} failed: ${errorMessage(e)}`;
            output.appendLine(msg);
            files.forEach((f) => failed.push(`${f.display}: ${msg}`));
            continue;
          }

          const knownDirs = new Set<string>();
          try {
            for (const f of files) {
              if (token.isCancellationRequested) {
                cancelled = true;
                break;
              }
              progress.report({ message: f.display, increment: 100 / total });
              try {
                const stat = await lstatSafe(f.localPath);
                if (!stat) {
                  if (deleteRemote) {
                    await client.delete(f.remotePath, true);
                    deleted++;
                    output.appendLine(`  deleted     ${f.remotePath}`);
                  } else {
                    skipped.push(f.display);
                    output.appendLine(`  skipped (deleted locally)  ${f.display}`);
                  }
                } else if (stat.isSymbolicLink()) {
                  // Never follow symlinks: a link to a file outside the repo would upload that file's contents.
                  skipped.push(f.display);
                  output.appendLine(`  skipped (symbolic link)  ${f.display}`);
                } else if (stat.isDirectory()) {
                  await client.uploadDir(f.localPath, f.remotePath, {
                    filter: (p) => !isSymlinkSync(p),
                  });
                  uploaded++;
                  output.appendLine(`  directory   ${f.display} → ${f.remotePath}`);
                } else {
                  const dir = path.posix.dirname(f.remotePath);
                  if (!knownDirs.has(dir)) {
                    if (!(await client.exists(dir))) await client.mkdir(dir, true);
                    knownDirs.add(dir);
                  }
                  await client.put(f.localPath, f.remotePath);
                  uploaded++;
                  output.appendLine(`  uploaded    ${f.display} → ${f.remotePath}`);
                }
              } catch (e) {
                const msg = `${f.display}: ${errorMessage(e)}`;
                failed.push(msg);
                output.appendLine(`  ERROR       ${msg}`);
              }
            }
          } finally {
            await client.end().catch(() => undefined);
          }
        }
      }
    );
  }

  // 3. Summary
  const parts = [`${uploaded} file(s) uploaded`];
  if (deleted) parts.push(`${deleted} deleted on server`);
  if (skipped.length) parts.push(`${skipped.length} skipped`);
  if (cancelled) parts.push('cancelled');
  const summary = parts.join(', ');
  output.appendLine(summary);

  if (failed.length) {
    failed.forEach((f) => output.appendLine(`  ERROR  ${f}`));
    const choice = await vscode.window.showErrorMessage(
      `${summary}. ${failed.length} failed: ${failed[0]}${failed.length > 1 ? ' …' : ''}`,
      'Show log'
    );
    if (choice) output.show();
  } else if (cancelled) {
    vscode.window.showWarningMessage(summary);
  } else {
    vscode.window.showInformationMessage(summary);
  }
}
