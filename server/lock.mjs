import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function acquireDataLock(dataDir) {
  const path = join(dataDir, 'relay.lock');
  const claim = (attempt) => {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid = 0;
      try {
        pid = Number(readFileSync(path, 'utf8'));
      } catch (readError) {
        if (readError.code !== 'ENOENT') throw readError;
      }
      if (processAlive(pid)) throw new Error('已有轻传进程正在使用该数据目录', { cause: error });
      try {
        unlinkSync(path);
      } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      }
      if (attempt >= 3) throw new Error('已有轻传进程正在使用该数据目录', { cause: error });
      claim(attempt + 1);
    }
  };
  claim(0);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      if (Number(readFileSync(path, 'utf8')) === process.pid) unlinkSync(path);
    } catch {
      /* Lock file already removed. */
    }
  };
  process.on('exit', release);
  return () => {
    process.removeListener('exit', release);
    release();
  };
}
