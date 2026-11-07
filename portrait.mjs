import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { bindReference, importBooks, librarySummary, loadLibrary, saveTheme } from './src/library.mjs';
import { createBatch, listBatches, preview, recordJob, runJob, showBatch } from './src/jobs.mjs';
import { imageConfig, imageGenerator } from './src/image-api.mjs';
import { readJson } from './src/storage.mjs';
import { serve } from './src/server.mjs';

const help = [
    'npm start | node portrait.mjs serve [--port 8765]',
    'node portrait.mjs import --worlds <SillyTavern/data/default-user/worlds>',
    'node portrait.mjs import --world <本体.json> --workshop <工坊.json>',
    'node portrait.mjs library | themes | batches',
    'node portrait.mjs reference <角色名> --image <参考图>',
    'node portrait.mjs theme add --name <新主题> --file <提示词.md> [--reference none|optional|required]',
    'node portrait.mjs preview|queue --theme <主题> --role <姓名> [--role <姓名>] [--identity <角色=身份>] [--brief <要求>]',
    'node portrait.mjs show <批次ID>',
    'node portrait.mjs run <批次ID> [--role <姓名>]   使用已配置的生图服务',
    'node portrait.mjs complete <批次ID> <姓名或任务ID> --image <成图>',
    'node portrait.mjs fail <批次ID> <姓名或任务ID> --error <原因>',
].join('\n');

const options = Object.fromEntries(
    ['port', 'worlds', 'world', 'workshop', 'image', 'name', 'file', 'reference', 'theme', 'brief', 'error']
        .map(key => [key, { type: 'string' }]),
);
options.role = { type: 'string', multiple: true };
options.identity = { type: 'string', multiple: true };

function required(value, label) {
    if (!value) throw new Error('请提供 ' + label + '。');
    return value;
}

async function bookPaths(values) {
    if (values.world || values.workshop || !values.worlds) {
        return [required(values.world, '--world'), required(values.workshop, '--workshop')];
    }
    const names = await readdir(values.worlds);
    const world = names.filter(name => /^《道渊》v\d+(?:\.\d+)*\.json$/iu.test(name))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
    const workshop = names.filter(name => /^DaoYuan Workshop · .+\.json$/iu.test(name));
    if (!world) throw new Error('目录里找不到《道渊》v*.json，请用 --world 指定。');
    if (workshop.length !== 1) throw new Error('请用 --world 和 --workshop 指定本体和对应的工坊世界书。');
    return [world, workshop[0]].map(name => join(values.worlds, name));
}

function queueOptions(values) {
    const identities = Object.fromEntries((values.identity ?? []).map(pair => {
        const index = pair.indexOf('=');
        if (index < 1 || !pair.slice(index + 1).trim()) throw new Error('--identity 使用「角色=身份」格式。');
        return [pair.slice(0, index).trim(), pair.slice(index + 1).trim()];
    }));
    return {
        theme: required(values.theme, '--theme'),
        roles: (values.role ?? []).flatMap(names => names.split(/[、,，\n]+/u)).map(name => name.trim()).filter(Boolean),
        brief: values.brief,
        identities,
    };
}

async function main() {
    const { values, positionals } = parseArgs({ options, allowPositionals: true, args: process.argv.slice(2) });
    const [command, first, second] = positionals;
    switch (command) {
        case 'serve':
            return serve(values.port);
        case 'import': {
            const files = await bookPaths(values);
            const books = await Promise.all(files.map(path => readJson(path)));
            return { ...await importBooks(...books), files };
        }
        case 'library':
            return librarySummary();
        case 'themes':
            return (await loadLibrary()).themes;
        case 'reference':
            return bindReference(required(first, '角色名'), await readFile(required(values.image, '--image')));
        case 'theme':
            if (first !== 'add') throw new Error('请使用 theme add。');
            return saveTheme({ name: values.name, prompt: await readFile(required(values.file, '--file'), 'utf8'), reference: values.reference });
        case 'preview':
            return preview(queueOptions(values));
        case 'queue':
            return createBatch(queueOptions(values));
        case 'batches':
            return listBatches();
        case 'show':
            return showBatch(required(first, '批次 ID'));
        case 'run': {
            const batch = await showBatch(required(first, '批次 ID'));
            const config = imageConfig();
            if (!config) throw new Error('请先配置生图服务，或由 Codex 逐个处理本批次。');
            const generate = imageGenerator(config);
            const names = values.role ?? batch.jobs.filter(job => ['pending', 'failed'].includes(job.status)).map(job => job.id);
            const results = [];
            for (const role of names) {
                const result = await runJob(first, role, generate).catch(error => ({ status: 'failed', error: error.message }));
                results.push({ role, ...result });
            }
            if (results.some(result => result.status === 'failed')) process.exitCode = 1;
            return { batch: first, results };
        }
        case 'complete':
        case 'fail': {
            const batch = required(first, '批次 ID');
            const role = required(second, '角色名或任务 ID');
            return recordJob(batch, role, command === 'complete'
                ? { image: await readFile(required(values.image, '--image')) }
                : { error: required(values.error, '--error') });
        }
        case undefined:
        case 'help':
            console.log(help);
            return;
        default:
            throw new Error('未知命令「' + command + '」。运行 node portrait.mjs help 查看用法。');
    }
}

try {
    const result = await main();
    if (result !== undefined) console.log(JSON.stringify(result, null, 2));
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
