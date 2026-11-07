import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKioAAAAASUVORK5CYII=', 'base64');

test('九人批次、工坊身份、主题新增、参考图、失败重试与并发', async t => {
    const home = await mkdtemp(join(tmpdir(), 'portrait-test-'));
    const originalHome = process.env.PORTRAIT_HOME;
    process.env.PORTRAIT_HOME = home;
    t.after(async () => {
        if (originalHome === undefined) delete process.env.PORTRAIT_HOME;
        else process.env.PORTRAIT_HOME = originalHome;
        await rm(home, { recursive: true, force: true });
    });

    const { bindReference, importBooks, librarySummary, saveTheme } = await import('../src/library.mjs');
    const { createBatch, listBatches, preview, recordJob, runJob, showBatch } = await import('../src/jobs.mjs');
    const { imageGenerator } = await import('../src/image-api.mjs');
    const characters = Array.from({ length: 9 }, (_, i) => '试作角色' + (i + 1));
    const world = { entries: [
        { comment: '世界观概述', content: '临水山城。' },
        ...characters.map((name, i) => ({
            comment: '人物详情：' + name,
            key: ['别名' + (i + 1)],
            content: '姓名：' + name + '\n武器编号 ' + (i + 1),
        })),
    ] };
    const workshop = { entries: [
        { comment: '[DLC][道渊每周主题立绘提示词][test][道渊立绘_魔法学院提示词]',
            content: '校园\n【在此填寫】\n【在此填寫完整角色設定】\n【在此填寫此次角色扮演的身份，例如學生會長】', disable: true },
        { comment: '[DLC][道渊每周主题立绘提示词][test][道渊立绘_魔法学院身份提示词]',
            content: '① 學生會長\n随身徽章。\n② 教授\n随身书册。' },
        { comment: '[DLC][道渊每周主题立绘提示词][test][道渊立绘_真人1]', content: '参考图为角色视觉来源。' },
        { comment: '[MOD][人物扩展_第十人][test][扩展人物详情_第十人]', content: '姓名：第十人\n校门守卫。' },
    ] };
    assert.deepEqual(await importBooks(world, workshop), { roles: 10, themes: 2, identities: 2 });

    const options = { theme: '魔法学院', roles: ['别名1', ...characters], identities: { [characters[0]]: '學生會長' }, brief: '竖幅' };
    const draft = await preview(options);
    assert.equal(draft.jobs.length, 9);
    assert.match(draft.jobs[0].prompt, /临水山城。[\s\S]+武器编号 1[\s\S]+随身徽章。[\s\S]+竖幅/u);
    assert.doesNotMatch(draft.jobs[0].prompt, /随身书册|【在此填寫/u);
    const batch = await createBatch(options);
    assert.equal(batch.jobs.length, 9);
    assert.equal(await readFile(batch.jobs[0].promptPath, 'utf8'), draft.jobs[0].prompt + '\n');

    await saveTheme({ name: '夜灯', prompt: '只画{{角色名}}。设定如下\n{{角色设定}}' });
    await importBooks(world, workshop);
    assert.equal((await librarySummary()).themes.length, 3);
    assert.match((await preview({ theme: '夜灯', roles: [characters[1]] })).jobs[0].prompt, /只画试作角色2。/u);

    const withRef = { theme: '真人1', roles: [characters[0]] };
    assert.equal((await preview(withRef)).jobs[0].missingReference, true);
    await assert.rejects(createBatch(withRef), /试作角色1/u);
    await bindReference(characters[0], png);
    const referenceBatch = await createBatch(withRef);
    assert.deepEqual(await readFile(referenceBatch.jobs[0].referencePath), png);
    assert.equal((await listBatches()).length, 2);

    const calls = [];
    const provider = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        calls.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        const first = calls.length === 1;
        res.writeHead(first ? 429 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(first ? { error: 'busy' } : { data: [{ b64_json: png.toString('base64') }] }));
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    t.after(() => new Promise(resolve => provider.close(resolve)));
    const generate = imageGenerator({ base: 'http://127.0.0.1:' + provider.address().port + '/v1', model: 'test', key: 'test-only' });

    const job = batch.jobs[0];
    assert.equal((await runJob(batch.id, job.id, generate)).status, 'failed');
    assert.equal((await showBatch(batch.id)).jobs[0].status, 'failed');
    const done = await runJob(batch.id, job.id, generate);
    assert.equal(done.status, 'done');
    assert.deepEqual(await readFile(done.imagePath), png);
    assert.match(JSON.parse(calls[1].body).prompt, /试作角色1/u);
    assert.equal(calls[1].headers.authorization, 'Bearer test-only');
    await runJob(batch.id, job.id, generate);
    assert.equal(calls.length, 2);
    await assert.rejects(recordJob(batch.id, job.id, { image: png }), /已有成图/u);

    const referenceJob = referenceBatch.jobs[0];
    assert.equal((await runJob(referenceBatch.id, referenceJob.id, generate)).status, 'done');
    assert.equal(calls[2].path, '/v1/images/edits');
    assert.match(calls[2].body, /name="image"; filename="reference.png"/u);

    let release;
    let acquired;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { acquired = resolve; });
    const next = runJob(batch.id, batch.jobs[1].id, async () => {
        acquired();
        await gate;
        return png;
    });
    await started;
    try {
        await assert.rejects(recordJob(batch.id, batch.jobs[1].id, { image: png }), /已在运行/u);
    } finally {
        release();
        await next;
    }
    assert.equal((await showBatch(batch.id)).jobs[1].status, 'done');

    const { parsePortraitIndex } = await import('../src/references.mjs');
    const { downloadImage } = await import('../src/remote-image.mjs');
    const { writeAtomic, writeJson } = await import('../src/storage.mjs');
    const normalUrl = 'https://example.com/normal.png';
    const specialUrl = 'https://example.com/special.png';
    const portraits = parsePortraitIndex({ schemaVersion: 2, data: { entities: {
        [characters[0]]: { type: 'character', images: [{ theme: 'normal', url: normalUrl }, { theme: 'special', url: specialUrl }] },
        '别名2': { type: 'character', images: [{ theme: 'default', url: normalUrl }] },
        '门派': { type: 'sect', images: [{ theme: 'default', url: normalUrl }] },
    } } });
    await writeJson(join(home, 'portraits.json'), { portraits, syncedAt: new Date().toISOString() });
    for (const url of [normalUrl, specialUrl]) {
        await writeAtomic(join(home, 'portrait-cache', createHash('sha256').update(url).digest('hex')), png);
    }
    assert.equal((await librarySummary()).portraitSync.matched, 2);
    const mixed = {
        theme: '魔法学院', roles: characters.slice(0, 3), referenceType: '常态立绘',
        roleReferences: { [characters[0]]: '心动立绘' },
    };
    const draftWithRefs = await preview(mixed);
    assert.deepEqual(draftWithRefs.jobs.map(job => [job.referenceType, job.hasReference]), [
        ['special', true], ['default', true], ['default', false],
    ]);
    const copied = await createBatch(mixed);
    assert.deepEqual(await readFile(copied.jobs[0].referencePath), png);
    assert.equal(copied.jobs[2].referenceUnavailable, true);
    const disabled = await preview({ ...mixed, referenceType: '不使用参考图', roleReferences: {} });
    assert.ok(disabled.jobs.every(job => !job.hasReference && !job.referenceUnavailable));
    await assert.rejects(downloadImage('https://127.0.0.1/test.png'), /本机或内网/u);
    await assert.rejects(downloadImage('https://[::ffff:127.0.0.1]/test.png'), /本机或内网/u);
    await assert.rejects(downloadImage('file:///test.png'), /HTTPS/u);
});
