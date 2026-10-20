# Git SFTP Upload

Upload the files you changed in git to your server via SFTP or FTPS, straight from VS Code: from the **Git SFTP Upload** view in the Activity Bar or from the **Source Control** view. Uses the `.vscode/sftp.json` you already have.

**Install:** search for *Git SFTP Upload* in the Extensions view, or open `vscode:extension/delta-solutions.git-sftp-upload`. Also available for Cursor and VSCodium through [Open VSX](https://open-vsx.org/extension/delta-solutions/git-sftp-upload).

## Usage

### Git SFTP Upload view

Click the **cloud icon** in the Activity Bar. The view lists only the files git reports as changed, grouped into *Staged Changes*, *Changes* and *Untracked Files*.

- **Hover a file** and click its cloud icon, or right-click → **Upload via SFTP**. Multi-selection (Cmd/Ctrl-click) is supported.
- **Hover a group header** and click its cloud icon to upload the whole group.
- **Cloud icon in the view header** uploads all staged, changed and untracked files.

### Source Control view

- **Right-click a file** under *Changes* or *Staged Changes* → **Upload via SFTP**. Also works with multiple selected files.
- **Right-click the group header** (*Changes* / *Staged Changes*) → **Upload All via SFTP**.
- **`...` menu at the top of Source Control** → **Upload All Changed Files via SFTP** (staged + unstaged + untracked).

Progress and details are shown in the Output panel under *Git SFTP Upload*. A full user guide with screenshots (PDF) is available from Delta Solutions: https://www.deltasolutions.be/delta-tools-center/downloads/git-sftp-upload/Git-SFTP-Upload-User-Guide-0.1.0.pdf

## Configuration

The extension reads the same `.vscode/sftp.json` as the SFTP extension by Natizyskunk, so there is nothing extra to set up. Supported: `host`, `port`, `username`, `password`, `privateKeyPath`, `passphrase`, `agent`, `remotePath`, `context`, `connectTimeout`, `profiles` + `defaultProfile`, and an array of configs.

Protocols:

- `"protocol": "sftp"` (default): SFTP over SSH, with password, private key or agent authentication.
- `"protocol": "ftp"`: FTPS with explicit TLS on port 21 by default. `"secure": "implicit"` uses implicit FTPS on port 990. `"secureOptions"` is passed to Node's TLS connection (for example `{ "rejectUnauthorized": false }` for a self-signed certificate, which is warned about). Unencrypted FTP is only used with an explicit `"secure": false`.

If there is no `defaultProfile`, the extension asks once per upload which profile you want to use.

Settings:

- `gitSftpUpload.configFile`: alternative path to the config (default `.vscode/sftp.json`).
- `gitSftpUpload.deleteRemoteOnDelete`: also delete locally deleted files on the server (off by default; they are skipped instead).

## Security

- **Host key verification (SFTP).** The server's SSH host key is checked against `~/.ssh/known_hosts`. Unknown hosts are shown once with their fingerprint and must be confirmed; the key is then remembered. A key that no longer matches is refused. Use **Git SFTP: Forget Trusted Host Keys** if a server key was changed on purpose.
- **Encrypted by default (FTP).** `"protocol": "ftp"` means FTPS with certificate verification. Plain FTP sends the password and every file in plaintext, so it requires `"secure": false` and is flagged in the Output panel.
- **Symbolic links are never followed.** Linked files and links inside uploaded directories are skipped, so a link pointing outside the repository cannot leak its target.
- **Trusted workspaces only.** The extension stays disabled in Restricted Mode, because the workspace itself decides where files are uploaded.
- **Config stays in the workspace.** `gitSftpUpload.configFile` must point inside the workspace folder.
- **Avoid plaintext passwords.** Use `"password": true` to be prompted instead; the Output panel warns when a plaintext password or passphrase is found.

## Publisher

Delta Solutions
