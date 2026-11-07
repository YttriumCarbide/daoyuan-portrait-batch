import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { bindReference, bindReferenceUrl, importBooks, librarySummary, saveTheme, viewReference } from './library.mjs';
import { createBatch, listBatches, preview, recordJob, runJob, showBatch } from './jobs.mjs';
import { imageConfig, imageGenerator } from './image-api.mjs';
import { syncPortraits } from './references.mjs';

const staticFiles = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const imageTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
const limit = 32 * 1024 * 1024;

function send(res, status, type, body) {
    res.writeHead(status, {
        'Content-Type': type,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    res.end(body);
}

function json(res, status, data) {
    send(res, status, 'application/json; charset=utf-8', JSON.stringify(data));
}

async function readBody(req) {
    if (Number(req.headers['content-length']) > limit) throw new Error('上传不能超过 32 MiB。');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw new Error('上传不能超过 32 MiB。');
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function readImage(value) {
    if (typeof value !== 'string' || !value) throw new Error('请选择图片。');
    return Buffer.from(value, 'base64');
}

function openWorkbench(origin) {
    execFile('rundll32.exe', ['url.dll,FileProtocolHandler', origin], { windowsHide: true }, error => {
        if (error) console.error('请在浏览器中打开 ' + origin);
    });
}

export function serve(input = '8765', { open = false } = {}) {
    if (open && process.platform !== 'win32') throw new Error('--open 用于 Windows 启动文件。');
    const port = Number(input);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口需为 1024 至 65535 的整数。');
    const host = '127.0.0.1:' + port;
    const origin = 'http://' + host;
    const running = new Set();

    async function route(req, res) {
        if (req.headers.host !== host) return json(res, 403, { error: '请从 ' + origin + ' 打开。' });
        const url = new URL(req.url, origin);
        const batch = url.searchParams.get('batch');
        if (req.method === 'GET') {
            const file = Object.hasOwn(staticFiles, url.pathname) ? staticFiles[url.pathname] : null;
            if (file) return send(res, 200, file[1], await readFile(new URL('../web/' + file[0], import.meta.url)));
            switch (url.pathname) {
                case '/api/library':
                    return json(res, 200, { ...await librarySummary(), provider: Boolean(imageConfig()) });
                case '/api/batches':
                    return json(res, 200, await listBatches());
                case '/api/batch':
                    return json(res, 200, { ...await showBatch(batch), running: running.has(batch) });
                case '/api/image': {
                    const job = (await showBatch(batch)).jobs.find(item => item.id === url.searchParams.get('role'));
                    if (!job?.imagePath) return json(res, 404, { error: '找不到成图。' });
                    return send(res, 200, imageTypes[extname(job.imagePath)], await readFile(job.imagePath));
                }
            }
        }
        if (req.method === 'POST') {
            if (req.headers.origin !== origin || !req.headers['content-type']?.startsWith('application/json')) {
                return json(res, 403, { error: '此请求只接受本工具页面提交的 JSON。' });
            }
            const body = await readBody(req);
            switch (url.pathname) {
                case '/api/import':
                    return json(res, 200, await importBooks(body.world, body.workshop));
                case '/api/theme':
                    return json(res, 200, await saveTheme(body));
                case '/api/portrait-sync':
                    await syncPortraits();
                    return json(res, 200, (await librarySummary()).portraitSync);
                case '/api/reference':
                    return json(res, 200, body.url ? await bindReferenceUrl(body.role, body.url)
                        : await bindReference(body.role, readImage(body.image)));
                case '/api/reference-image': {
                    const image = await viewReference(body.role, body.type);
                    return send(res, 200, imageTypes['.' + image.extension], image.bytes);
                }
                case '/api/preview':
                    return json(res, 200, await preview(body));
                case '/api/queue':
                    return json(res, 201, await createBatch(body));
                case '/api/complete':
                    return json(res, 200, await recordJob(body.batch, body.role, { image: readImage(body.image) }));
                case '/api/run': {
                    const config = imageConfig();
                    if (!config) throw new Error('请先配置生图服务，或将这批交给 Codex。');
                    const jobBatch = await showBatch(body.batch);
                    if (running.has(body.batch)) throw new Error('此批次正在运行。');
                    const jobs = jobBatch.jobs.filter(job => ['pending', 'failed'].includes(job.status) &&
                        (!body.role || body.role === job.id));
                    if (!jobs.length) throw new Error('没有可运行的任务。');
                    const generate = imageGenerator(config);
                    running.add(body.batch);
                    void (async () => {
                        try {
                            for (const job of jobs) {
                                await runJob(body.batch, job.id, generate).catch(error => {
                                    console.error(job.name + ' · ' + error.message);
                                });
                            }
                        } finally {
                            running.delete(body.batch);
                        }
                    })();
                    return json(res, 202, { count: jobs.length });
                }
            }
        }
        return json(res, 404, { error: '找不到此页面。' });
    }

    const server = createServer((req, res) => {
        route(req, res).catch(error => json(res, 400, { error: error.message }));
    });
    server.on('error', async error => {
        if (open && error.code === 'EADDRINUSE') {
            const page = await fetch(origin, { redirect: 'error', signal: AbortSignal.timeout(1500) })
                .then(response => response.ok ? response.text() : '').catch(() => '');
            if (page.includes('<title>道渊批量立绘</title>')) {
                openWorkbench(origin);
                return;
            }
        }
        console.error(error.code === 'EADDRINUSE' ? '端口已被占用。请打开原页面或使用 --port 指定其他端口。' : error.message);
        process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => {
        console.log('道渊批量立绘 · ' + origin);
        if (open) openWorkbench(origin);
    });
}
