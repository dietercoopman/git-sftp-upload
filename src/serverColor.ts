// Colors the upload buttons with the color of the server they upload to ("color" in sftp.json, as set with
// SFTP Remote Editor), so an upload to a red production server has a red button.
//
// Toolbar icons are fixed in package.json, so every color has its own variant of the upload commands, and the
// context key gitSftpUpload.serverColor decides which one is shown. The target is the server "Upload All" goes
// to without asking: the config itself, or its defaultProfile. When a profile has to be chosen at upload time,
// the target is unknown and the buttons stay neutral. With several targets, the most alarming color wins.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseJsonc } from 'jsonc-parser';

/** In order of urgency: the first color among the targets is the one shown. */
export const SERVER_COLORS = {
  red: '🔴',
  orange: '🟠',
  yellow: '🟡',
  purple: '🟣',
  blue: '🔵',
  green: '🟢',
} as const;

export type ServerColor = keyof typeof SERVER_COLORS;

const CONTEXT_KEY = 'gitSftpUpload.serverColor';

interface Target {
  name: string;
  color?: ServerColor;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function colorOf(v: unknown): ServerColor | undefined {
  const c = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(SERVER_COLORS, c) ? (c as ServerColor) : undefined;
}

/** The servers "Upload All" goes to without asking, or undefined when a profile must be chosen first. */
export function uploadTargets(raw: unknown): Target[] | undefined {
  const targets: Target[] = [];
  for (const entry of Array.isArray(raw) ? raw : [raw]) {
    if (!isObject(entry)) continue;
    const base = String(entry.name ?? entry.host ?? 'server');
    const profiles = isObject(entry.profiles) ? entry.profiles : {};
    if (Object.keys(profiles).length) {
      const def = typeof entry.defaultProfile === 'string' ? entry.defaultProfile : undefined;
      if (!def || !isObject(profiles[def])) return undefined;
      const settings = { ...entry, ...(profiles[def] as Record<string, unknown>) };
      targets.push({ name: `${settings.name ?? base} (${def})`, color: colorOf(settings.color) });
    } else {
      targets.push({ name: base, color: colorOf(entry.color) });
    }
  }
  return targets;
}

/** The color for a set of targets: the most urgent one any of them has. */
export function colorFor(targets: Target[]): ServerColor | undefined {
  return (Object.keys(SERVER_COLORS) as ServerColor[]).find((c) => targets.some((t) => t.color === c));
}

export class ServerColorIndicator implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly view: vscode.TreeView<unknown>) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.json');
    const update = () => void this.update();
    this.disposables.push(
      watcher,
      watcher.onDidChange(update),
      watcher.onDidCreate(update),
      watcher.onDidDelete(update),
      vscode.workspace.onDidChangeWorkspaceFolders(update),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gitSftpUpload.configFile')) update();
      })
    );
    update();
  }

  private async readTargets(): Promise<Target[] | undefined> {
    const all: Target[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== 'file') continue;
      const rel = vscode.workspace.getConfiguration('gitSftpUpload', folder.uri).get<string>('configFile', '.vscode/sftp.json');
      const cfgPath = path.resolve(folder.uri.fsPath, rel);
      const inside = path.relative(folder.uri.fsPath, cfgPath);
      if (inside.startsWith('..') || path.isAbsolute(inside) || !fs.existsSync(cfgPath)) continue;
      try {
        const targets = uploadTargets(parseJsonc(await fs.promises.readFile(cfgPath, 'utf8'), [], { allowTrailingComma: true }));
        if (!targets) return undefined;
        all.push(...targets);
      } catch {
        return undefined;
      }
    }
    return all;
  }

  async update(): Promise<void> {
    const targets = await this.readTargets();
    const color = targets?.length ? colorFor(targets) : undefined;
    await vscode.commands.executeCommand('setContext', CONTEXT_KEY, color ?? '');
    // A message above the files, not a description: VS Code hides the description of a view that is alone in
    // its container, as this one is.
    if (!targets?.length) {
      this.view.message = undefined;
      return;
    }
    const dot = color ? `${SERVER_COLORS[color]} ` : '';
    this.view.message = `Uploads to ${dot}${targets.length === 1 ? targets[0].name : `${targets.length} servers`}`;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
