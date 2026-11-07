import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { findNamed, loadLibrary } from './library.mjs';
import {
    chooseReference, defaultReferenceType, loadReferenceImage, loadReferences, referenceLabel, resolveReferenceType,
} from './references.mjs';
import { home, imageExtension, readJson, writeAtomic, writeJson } from './storage.mjs';

const batchesDir = join(home, 'batches');
const batchPattern = /^\d{8}-[a-f0-9]{12}$/;

function batchDir(id) {
    if (!batchPattern.test(id)) throw new Error('批次 ID 无效。');
    return join(batchesDir, id);
}

function renderPrompt({ theme, role, lore, identity, brief, reference }) {
    const identityText = identity?.content ?? (theme.identities.length
        ? '按角色原设选择一个最适合的学院身份。可选身份：' + theme.identities.map(item => item.name).join('、') + '。'
        : '');
    const slots = {
        '角色名': role.name,
        '角色设定': role.content,
        '世界观': lore,
        '主题身份': identityText,
        '补充要求': brief,
    };
    const used = new Set();
    const body = theme.prompt.replace(
        /\{\{(角色名|角色设定|世界观|主题身份|补充要求)\}\}|【在此填[寫写](完整角色設定|此次角色扮演的身份[^】]*|角色在魔法學院中的[^】]*)?】|【可選填[^】]*】/gu,
        (match, slot, workshopSlot) => {
            if (!slot) {
                if (match.startsWith('【可選填')) return '由角色与主题决定';
                if (!workshopSlot) slot = '角色名';
                else if (workshopSlot === '完整角色設定') slot = '角色设定';
                else if (workshopSlot.startsWith('此次角色扮演')) return identity?.name ?? '由角色原设决定';
                else return '由角色原设与所选身份决定';
            }
            used.add(slot);
            return slots[slot];
        },
    );
    const sections = [
        lore && !used.has('世界观') && '## 道渊世界观\n' + lore,
        '## 主题 · ' + theme.name + '\n' + body,
        !used.has('角色设定') && '## 角色设定 · ' + role.name + '\n' + role.content,
        identityText && !used.has('主题身份') && '## 本次身份\n' + identityText,
        brief && !used.has('补充要求') && '## 本批补充要求\n' + brief,
        reference && '## 人物参考图\n参考图用于保持角色辨识特征。服装、场景和画风按本次主题处理；主题已有参考图规则时按其规定执行。',
    ];
    return sections.filter(Boolean).join('\n\n');
}

async function plan({ theme, roles, brief = '', identities = {}, referenceType = defaultReferenceType, roleReferences = {} } = {}) {
    if (!Array.isArray(roles) || roles.length === 0 || roles.length > 250) throw new Error('请选择 1 至 250 个角色。');
    if (typeof brief !== 'string' || brief.length > 3000) throw new Error('补充要求最多 3000 字。');
    if (!identities || typeof identities !== 'object' || Array.isArray(identities)) throw new Error('角色身份设置无效。');
    if (!roleReferences || typeof roleReferences !== 'object' || Array.isArray(roleReferences)) {
        throw new Error('角色参考图设置无效。');
    }
    const [library, refs] = await Promise.all([loadLibrary(), loadReferences()]);
    const template = findNamed(library.themes, theme, '主题');
    const selected = [...new Map(roles.map(name => {
        const role = findNamed(library.roles, name, '角色');
        return [role.id, role];
    })).values()];
    const assigned = new Map(Object.entries(identities).filter(([, identity]) => identity).map(([name, identity]) => [
        findNamed(selected, name, '已选角色').id, findNamed(template.identities, identity, '学院身份'),
    ]));
    const batchType = resolveReferenceType(refs, referenceType);
    const overrides = new Map(Object.entries(roleReferences).map(([name, type]) => [
        findNamed(selected, name, '已选角色').id, resolveReferenceType(refs, type),
    ]));
    const items = [];
    for (const role of selected) {
        const identity = assigned.get(role.id);
        const type = template.reference === 'none' ? 'none' : overrides.get(role.id) ?? batchType;
        const reference = chooseReference(role, refs, type, !overrides.has(role.id));
        items.push({
            id: role.id,
            name: role.name,
            identity: identity?.name ?? null,
            prompt: renderPrompt({ theme: template, role, lore: library.lore, identity, brief: brief.trim(), reference }),
            reference,
            referenceType: reference?.type ?? type,
            referenceUnavailable: type !== 'none' && !reference,
            missingReference: template.reference === 'required' && !reference,
        });
    }
    return { theme: { id: template.id, name: template.name }, items };
}

export async function preview(options) {
    const { theme, items } = await plan(options);
    return { theme, jobs: items.map(({ reference, ...item }) => ({ ...item, hasReference: Boolean(reference) })) };
}

export async function createBatch(options) {
    const { theme, items } = await plan(options);
    const missing = items.filter(item => item.missingReference).map(item => item.name);
    if (missing.length) throw new Error('该主题需要参考图，请调整类型或补图：' + missing.join('、'));
    const created = new Date();
    const id = created.toISOString().slice(0, 10).replaceAll('-', '') + '-' + randomUUID().replaceAll('-', '').slice(0, 12);
    const path = batchDir(id);
    const temp = join(batchesDir, '.' + id);
    await mkdir(batchesDir, { recursive: true });
    await mkdir(temp);
    try {
        const jobs = [];
        for (let index = 0; index < items.length; index += 4) {
            const results = await Promise.allSettled(items.slice(index, index + 4).map(async item => {
                const dir = join(temp, item.id);
                await writeAtomic(join(dir, 'prompt.md'), item.prompt + '\n');
                let image;
                if (item.reference) {
                    try { image = await loadReferenceImage(item.reference); } catch (error) {
                        throw new Error('「' + item.name + '」的' + referenceLabel(item.referenceType) + '下载失败：' + error.message);
                    }
                }
                const referenceFile = image ? 'reference.' + image.extension : null;
                if (referenceFile) await writeAtomic(join(dir, referenceFile), image.bytes);
                return {
                    id: item.id, name: item.name, identity: item.identity, referenceFile,
                    referenceType: item.referenceType, referenceUnavailable: item.referenceUnavailable,
                };
            }));
            for (const result of results) {
                if (result.status === 'rejected') throw result.reason;
                jobs.push(result.value);
            }
        }
        await writeJson(join(temp, 'batch.json'), { id, created: created.toISOString(), theme, jobs });
        await rename(temp, path);
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
    return showBatch(id);
}

async function loadBatch(id) {
    const path = batchDir(id);
    const manifest = await readJson(join(path, 'batch.json'), null);
    if (!manifest) throw new Error('找不到批次「' + id + '」。');
    return { path, manifest };
}

async function isLocked(dir) {
    return stat(join(dir, 'running.lock')).then(() => true, error => {
        if (error.code === 'ENOENT') return false;
        throw error;
    });
}

async function jobState(dir) {
    const [result, failure, locked] = await Promise.all([
        readJson(join(dir, 'result.json'), null),
        readJson(join(dir, 'failure.json'), null),
        isLocked(dir),
    ]);
    if (result) return { status: 'done', imagePath: join(dir, result.file) };
    if (locked) return { status: 'running' };
    if (failure) return { status: 'failed', error: failure.message };
    return { status: 'pending' };
}

export async function showBatch(id) {
    const { path, manifest } = await loadBatch(id);
    const jobs = await Promise.all(manifest.jobs.map(async ({ referenceFile, ...job }) => {
        const dir = join(path, job.id);
        return { ...job, promptPath: join(dir, 'prompt.md'),
            referencePath: referenceFile ? join(dir, referenceFile) : null, ...await jobState(dir) };
    }));
    return { ...manifest, path, jobs };
}

export async function listBatches() {
    const names = await readdir(batchesDir).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
    });
    const manifests = await Promise.all(names.filter(name => batchPattern.test(name)).map(async name => {
        const { manifest } = await loadBatch(name);
        return { id: manifest.id, theme: manifest.theme.name, created: manifest.created, count: manifest.jobs.length };
    }));
    return manifests.sort((a, b) => b.created.localeCompare(a.created));
}

async function getJob(batch, role) {
    const { path, manifest } = await loadBatch(batch);
    const job = findNamed(manifest.jobs, role, '批次角色');
    return { job, dir: join(path, job.id) };
}

async function withJobLock(dir, action) {
    const path = join(dir, 'running.lock');
    const lock = await open(path, 'wx').catch(error => {
        if (error.code === 'EEXIST') throw new Error('此任务已在运行。');
        throw error;
    });
    try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
        await lock.close();
        return await action();
    } finally {
        await lock.close();
        await rm(path, { force: true });
    }
}

async function saveResult(dir, name, bytes) {
    const extension = imageExtension(bytes);
    const clean = name.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').slice(0, 80).replace(/[ .]+$/u, '');
    const file = '立绘-' + (clean || '角色') + '.' + extension;
    await writeAtomic(join(dir, file), bytes);
    await writeJson(join(dir, 'result.json'), { file, finished: new Date().toISOString() });
    return { status: 'done', imagePath: join(dir, file) };
}

async function saveFailure(dir, message) {
    const error = String(message || '生成失败。').slice(0, 500);
    await writeJson(join(dir, 'failure.json'), { message: error, time: new Date().toISOString() });
    return { status: 'failed', error };
}

export async function runJob(batch, role, generate) {
    const { job, dir } = await getJob(batch, role);
    return withJobLock(dir, async () => {
        const existing = await jobState(dir);
        if (existing.status === 'done') return existing;
        try {
            const prompt = await readFile(join(dir, 'prompt.md'), 'utf8');
            const reference = job.referenceFile ? await readFile(join(dir, job.referenceFile)) : null;
            const bytes = await generate({ prompt, reference, referenceFile: job.referenceFile });
            return await saveResult(dir, job.name, bytes);
        } catch (error) {
            return saveFailure(dir, error.message);
        }
    });
}

export async function recordJob(batch, role, { image, error }) {
    const { job, dir } = await getJob(batch, role);
    return withJobLock(dir, async () => {
        if ((await jobState(dir)).status === 'done') throw new Error('此角色已有成图。');
        if (image) return saveResult(dir, job.name, image);
        return saveFailure(dir, error);
    });
}
