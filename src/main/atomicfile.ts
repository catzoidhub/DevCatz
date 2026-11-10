import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';

/**
 * Writes a file so that after a crash or a power cut it holds either the old content or the new one. A temporary file
 * renamed into place is not enough on its own: without fsync the rename can reach the disk before the data, and the
 * file comes back full of zero bytes (DevCatz's and DoCatz's bridge.json and gw-pids.json after Windows hung and was
 * reset, 2026-11-10).
 */
export function writeFileAtomic(file: string, data: string, mode?: number): void {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw err;
  }
  closeSync(fd);
  renameSync(tmp, file);
}
