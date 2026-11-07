import { imageLimit } from './storage.mjs';

export function imageConfig() {
    const base = process.env.PORTRAIT_IMAGE_BASE_URL;
    const model = process.env.PORTRAIT_IMAGE_MODEL;
    if (!base || !model) return null;
    const url = new URL(base);
    if (url.username || url.password || url.search || url.hash ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
        throw new Error('生图地址需要 HTTPS，或使用本机 HTTP 地址。');
    }
    const size = process.env.PORTRAIT_IMAGE_SIZE;
    return {
        base: url.href.replace(/\/+$/u, ''),
        model,
        key: process.env.PORTRAIT_IMAGE_API_KEY,
        size,
    };
}

async function responseBytes(response, limit) {
    if (Number(response.headers.get('content-length')) > limit) throw new Error('生图服务返回的数据过大。');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > limit) throw new Error('生图服务返回的数据过大。');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

export function imageGenerator(config) {
    const { base, model, key, size } = config;
    return async ({ prompt, reference, referenceFile }) => {
        const headers = key ? { Authorization: 'Bearer ' + key } : {};
        const fields = { model, prompt, n: 1, ...(size ? { size } : {}) };
        let body;
        if (reference) {
            body = new FormData();
            for (const [name, value] of Object.entries(fields)) body.append(name, String(value));
            const types = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
            body.append('image', new Blob([reference], { type: types[referenceFile.split('.').at(-1)] }), referenceFile);
        } else {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(fields);
        }
        const response = await fetch(base + '/images/' + (reference ? 'edits' : 'generations'), {
            method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(300000),
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error('生图服务返回 HTTP ' + response.status + '。');
        }
        const data = JSON.parse(await responseBytes(response, Math.ceil(imageLimit * 1.4))).data?.[0];
        if (typeof data?.b64_json === 'string') return Buffer.from(data.b64_json, 'base64');
        if (typeof data?.url === 'string') {
            const url = new URL(data.url);
            if (url.protocol !== 'https:' || url.username || url.password) throw new Error('成图链接需要 HTTPS。');
            const image = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
            if (!image.ok) throw new Error('下载成图失败，HTTP ' + image.status + '。');
            return responseBytes(image, imageLimit);
        }
        throw new Error('生图服务没有返回图片。');
    };
}
