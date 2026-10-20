# Changelog

## 0.2.1

- Marketplace listing: README rewritten with screenshots of the Git SFTP Upload view, the Source Control menus, the host key check and the Output panel, plus a FAQ. No functional changes.

## 0.2.0

- **FTP and FTPS support.** Configs with `"protocol": "ftp"` now work, using the same fields as the SFTP extension by Natizyskunk (`secure`, `secureOptions`). FTPS with explicit TLS is the default; `"secure": "implicit"` selects implicit FTPS (port 990).
- **Unencrypted FTP only on request.** Plain FTP is used only with an explicit `"secure": false`, and the Output panel warns about it. Disabling certificate checks (`"rejectUnauthorized": false`) is warned about as well.
- Directory uploads over FTP skip symbolic links, like SFTP uploads do.

## 0.1.1

- Source code published on GitHub: https://github.com/dietercoopman/git-sftp-upload
- `repository` and `bugs` fields added to `package.json`.

## 0.1.0

Initial release.

- **Git SFTP Upload view** in the Activity Bar: lists only the files git reports as changed (staged, changed, untracked), with upload buttons per file, per group and for everything at once.
- **Source Control integration**: *Upload via SFTP* on files and groups, *Upload All Changed Files via SFTP* in the `...` menu and the command palette.
- Reads the existing `.vscode/sftp.json` (host, port, username, password, privateKeyPath, passphrase, agent, remotePath, context, profiles, defaultProfile, arrays of configs).
- **Host key verification** against `~/.ssh/known_hosts`, with a one-time fingerprint confirmation for new servers and a refusal when a key changes. *Forget Trusted Host Keys* command.
- Symbolic links are never followed; the extension only runs in trusted workspaces; the config file must live inside the workspace folder.
- Progress notification with cancel, result summary, and a full log in the *Git SFTP Upload* output channel.
