import fsp from 'node:fs/promises';

const BYTES_PER_SEC = {
  'audio/webm': 8000,
  'audio/ogg': 8000,
  'audio/mpeg': 16000,
  'audio/mp4': 16000,
  'audio/aac': 16000,
  'audio/flac': 88000,
};

async function wavDuration(filePath) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
    const { size } = await fh.stat();
    let byteRate = 0;
    for (let off = 12; off + 8 <= bytesRead; ) {
      const id = buf.toString('ascii', off, off + 4);
      const len = buf.readUInt32LE(off + 4);
      if (id === 'fmt ' && off + 20 <= bytesRead) byteRate = buf.readUInt32LE(off + 16);
      if (id === 'data' && byteRate) return Math.min(len, size - off - 8) / byteRate;
      off += 8 + len + (len % 2);
    }
    return null;
  } finally {
    await fh.close();
  }
}

export async function probeDuration(filePath, mimeType = '') {
  try {
    if (/wav/.test(mimeType)) {
      const exact = await wavDuration(filePath);
      if (exact) return exact;
    }
    const { size } = await fsp.stat(filePath);
    return size / (BYTES_PER_SEC[mimeType.split(';')[0]] ?? 16000);
  } catch {
    return 0;
  }
}
