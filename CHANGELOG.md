# Changelog

## 0.3.0

- **Respects the `ignore` list of sftp.json.** Changed files on that list (gitignore syntax, relative to the `context`), such as `/.env`, are skipped and logged, also inside an uploaded folder, and are never deleted on the server. Works with **Never Upload** in SFTP Folder Upload and with the `ignore` list of the SFTP extension by Natizyskunk.

## 0.2.6

- Marketplace listing: README with a rating badge, a "Get started in 30 seconds" section, a comparison with uploading by hand and full sync, more FAQ, and links to rate the extension. More search keywords. No functional changes.

## 0.2.5

- **Security fix: uploaded files no longer become world-writable.** SFTP uploads went through a library call that changed every uploaded file to mode 0666 (`-rw-rw-rw-`), also when the file already existed with stricter permissions. Uploads now keep the permissions of an existing file and give a new file the server's default permissions. Files uploaded with an earlier version may still be 0666 on the server; see the README to find and fix them.

## 0.2.4

- README badges: the Marketplace version and installs badges are back, now served by vsmarketplacebadges.dev instead of a static "install" badge. No functional changes.

## 0.2.3

- README badges: shields.io retired its Visual Studio Marketplace badges, which showed as "retired badge". The Marketplace badge is now a plain link and the installs badge is gone. No functional changes.

## 0.2.2

- Fixed the link to the PDF user guide in the README (and so on the Marketplace page): it now points to `Git-SFTP-Upload-User-Guide.pdf`, which no longer carries a version number. No functional changes.

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
