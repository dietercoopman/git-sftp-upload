// Uploads a local file over SFTP without changing the remote file's permissions.
//
// ssh2-sftp-client's put() writes through ssh2's write stream, which always chmods the remote file to
// 0666 after opening it, regardless of the server's umask. Every uploaded file would become world-writable,
// and an existing 0640 or 0644 file would be widened to 0666. Opening the file without attributes instead
// truncates an existing file and keeps its owner and mode, and gives a new file the server's default (umask).
//
// This module does not import vscode, so it can be tested on its own with plain Node.
import * as fs from 'fs';

/** The part of ssh2's SFTP channel used for writing. */
export interface RawSftp {
  open(path: string, flags: string, attrs: object, cb: (err: Error | undefined, handle: Buffer) => void): void;
  write(handle: Buffer, data: Buffer, offset: number, length: number, position: number, cb: (err?: Error) => void): void;
  close(handle: Buffer, cb: (err?: Error) => void): void;
}

const CHUNK = 32 * 1024;
/** Write requests in flight at once, so large files are not slowed down by one round trip per chunk. */
const PARALLEL = 8;

export async function putWithoutChmod(sftp: RawSftp, localPath: string, remotePath: string): Promise<void> {
  const file = await fs.promises.open(localPath, 'r');
  try {
    const handle = await new Promise<Buffer>((resolve, reject) =>
      sftp.open(remotePath, 'w', {}, (err, h) => (err ? reject(err) : resolve(h)))
    );
    try {
      const inFlight = new Set<Promise<void>>();
      let position = 0;
      for (;;) {
        const buffer = Buffer.alloc(CHUNK);
        const { bytesRead } = await file.read(buffer, 0, CHUNK, position);
        if (bytesRead === 0) break;
        const offset = position;
        position += bytesRead;
        const request = new Promise<void>((resolve, reject) =>
          sftp.write(handle, buffer, 0, bytesRead, offset, (err) => (err ? reject(err) : resolve()))
        );
        request.catch(() => undefined); // handled through race/all below
        inFlight.add(request);
        void request.finally(() => inFlight.delete(request)).catch(() => undefined);
        if (inFlight.size >= PARALLEL) await Promise.race(inFlight);
      }
      await Promise.all(inFlight);
    } finally {
      await new Promise<void>((resolve, reject) => sftp.close(handle, (err) => (err ? reject(err) : resolve())));
    }
  } finally {
    await file.close();
  }
}
