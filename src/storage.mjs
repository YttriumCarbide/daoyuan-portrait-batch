import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const home = resolve(process.env.PORTRAIT_HOME || fileURLToPath(new URL('../.portrait/', import.meta.url)));

export function idFor(name) {
    return createHash('sha256').update(name.normalize('NFKC').toLowerCase()).digest('hex').slice(0, 16);
}

export async function readJson(path, fallback) {
    try {
        return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
    } catch (error) {
        if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
        throw error;
    }
}

export async function writeAtomic(path, data) {
    await mkdir(dirname(path), { recursive: true });
    const temp = path + '.' + randomUUID() + '.tmp';
    try {
        await writeFile(temp, data, { flag: 'wx' });
        await rename(temp, path);
    } finally {
        await rm(temp, { force: true });
    }
}

export function writeJson(path, value) {
    return writeAtomic(path, JSON.stringify(value, null, 2) + '\n');
}

export const imageLimit = 20 * 1024 * 1024;

export function imageExtension(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length > imageLimit) throw new Error('图片不能超过 20 MiB。');
    if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
    if (bytes.length >= 4 && bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'jpg';
    if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    throw new Error('请选择 PNG、JPEG 或 WebP 图片。');
}
