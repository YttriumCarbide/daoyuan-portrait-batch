import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { home, idFor, readJson, writeJson } from './storage.mjs';
import { downloadImage } from './remote-image.mjs';
import {
    chooseReference, defaultReferenceType, loadReferenceImage, loadReferences, referenceTypes,
    resolveReferenceType, roleReferenceTypes, storeReference,
} from './references.mjs';

const libraryPath = join(home, 'library.json');
const themesDir = join(home, 'themes');
const empty = { roles: [], themes: [], lore: '' };

function entries(book) {
    const data = book?.data?.character_book ?? book?.character_book ?? book;
    if (!data?.entries || typeof data.entries !== 'object') throw new Error('需要包含 entries 的 SillyTavern 世界书 JSON。');
    return Object.values(data.entries)
        .filter(entry => typeof entry?.content === 'string' && entry.content.trim())
        .map(entry => ({
            title: String(entry.comment || entry.name || '').trim(),
            content: entry.content.trim(),
            keys: (Array.isArray(entry.key) ? entry.key : entry.keys ?? []).filter?.(key => typeof key === 'string') ?? [],
        }));
}

const roleTitle = /^(?:(?:仙界)?人物(?:详情|詳情|详细|詳細)|妖族人物)\s*[:：]\s*(.+)$/u;
const modTitle = /\[扩展人物详情[_：:]\s*([^\]]+)\]$/u;
const overviewTitle = /^(?:世界观(?:概述|简介)?|世界觀(?:概述|簡介)?|玄天界介绍|玄天界核心规则)$/u;
const identityHeading = /^[①-⑳]\s+(.+)$/gmu;

function rolesFrom(world, workshop) {
    const roles = new Map();
    for (const [source, group, pattern] of [['本体', world, roleTitle], ['工坊', workshop, modTitle]]) {
        for (const entry of group) {
            const label = entry.title.match(pattern)?.[1]?.trim();
            if (!label) continue;
            const name = (entry.content.match(/^\s*[-*]?\s*(?:姓名|名字)\s*[:：]\s*([^\r\n]+)/mu)?.[1] || label)
                .replace(/\s*[（(][^）)]*[）)]\s*$/u, '').trim() || label;
            const id = idFor(name);
            if (!roles.has(id)) roles.set(id, { id, name, aliases: [...new Set([label, ...entry.keys])], source, content: entry.content });
        }
    }
    return [...roles.values()];
}

function workshopThemes(workshop) {
    const themeEntries = workshop.filter(entry => /\[DLC\]\[道渊每周主题立绘提示词\]/u.test(entry.title));
    const supplement = themeEntries.find(entry => /魔法学院身份提示词/u.test(entry.title));
    const headings = [...(supplement?.content ?? '').matchAll(identityHeading)];
    const identities = headings.map((heading, index) => ({
        name: heading[1].trim(),
        content: supplement.content.slice(heading.index, headings[index + 1]?.index).trim(),
    }));
    return themeEntries.filter(entry => entry !== supplement).map(entry => {
        const label = entry.title.match(/\[道渊立绘_(.+)\]$/u)?.[1] ?? entry.title;
        const names = { jk: 'JK', '魔法学院提示词': '魔法学院' };
        const name = Object.hasOwn(names, label) ? names[label] : label;
        return {
            id: 'workshop-' + idFor(label),
            name,
            aliases: label !== name ? [label] : [],
            source: '工坊',
            prompt: entry.content,
            reference: /^真人/u.test(name) ? 'required' : 'optional',
            identities: /魔法学院/u.test(name) ? identities : [],
        };
    });
}

export async function importBooks(worldBook, workshopBook) {
    const world = entries(worldBook);
    const workshop = entries(workshopBook);
    const roles = rolesFrom(world, workshop);
    const themes = workshopThemes(workshop);
    if (!roles.some(role => role.source === '本体')) throw new Error('本体世界书里没有识别到人物详情条目。');
    if (!themes.length) throw new Error('工坊世界书里没有识别到「道渊每周主题立绘提示词」条目。');
    const lore = world.filter(entry => overviewTitle.test(entry.title))
        .map(entry => entry.title + '\n' + entry.content).join('\n\n');
    await writeJson(libraryPath, { roles, themes, lore });
    return { roles: roles.length, themes: themes.length, identities: themes.reduce((sum, theme) => sum + theme.identities.length, 0) };
}

export async function loadLibrary() {
    const library = await readJson(libraryPath, empty);
    const names = await readdir(themesDir).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
    });
    const custom = await Promise.all(names.filter(name => /^custom-[a-f0-9]{16}\.json$/.test(name))
        .sort().map(name => readJson(join(themesDir, name))));
    const workshop = library.themes.map(theme => theme.reference === 'none' && theme.source === '工坊'
        ? { ...theme, reference: 'optional' } : theme);
    return { ...library, themes: [...workshop, ...custom] };
}

export async function saveTheme({ name, prompt, reference = 'optional' } = {}) {
    name = typeof name === 'string' ? name.trim() : '';
    prompt = typeof prompt === 'string' ? prompt.trim() : '';
    if (!name || name.length > 80 || !prompt || prompt.length > 30000) {
        throw new Error('主题需要名称（最多 80 字）和正文（最多 30000 字）。');
    }
    if (!['none', 'optional', 'required'].includes(reference)) throw new Error('参考图设置无效。');
    const id = 'custom-' + idFor(name);
    const theme = { id, name, prompt, reference, source: '自定义', identities: [] };
    await writeJson(join(themesDir, id + '.json'), theme);
    return theme;
}

function normalize(value) {
    return String(value).normalize('NFKC').trim().toLowerCase();
}

export function findNamed(items, value, type) {
    const input = normalize(value);
    const exact = items.filter(item => item.id === input || normalize(item.name) === input);
    const matches = exact.length ? exact : items.filter(item => item.aliases?.some(alias => normalize(alias) === input));
    if (!matches.length) throw new Error('找不到' + type + '「' + value + '」。');
    if (matches.length > 1) throw new Error(type + '「' + value + '」有重名，请使用 ID。');
    return matches[0];
}

export async function bindReference(role, image) {
    const { roles } = await loadLibrary();
    const item = findNamed(roles, role, '角色');
    return storeReference(item, image);
}

export async function bindReferenceUrl(role, url) {
    const { roles } = await loadLibrary();
    const item = findNamed(roles, role, '角色');
    return storeReference(item, await downloadImage(url));
}

export async function viewReference(role, type = defaultReferenceType) {
    const [{ roles }, state] = await Promise.all([loadLibrary(), loadReferences()]);
    const item = findNamed(roles, role, '角色');
    const choice = chooseReference(item, state, resolveReferenceType(state, type), true);
    if (!choice) throw new Error('「' + item.name + '」没有此类型的参考图。');
    return { ...await loadReferenceImage(choice), name: item.name, type: choice.type };
}

export async function librarySummary() {
    const [{ roles, themes }, state] = await Promise.all([loadLibrary(), loadReferences()]);
    const roster = roles.map(({ id, name, aliases, source }) => ({
        id, name, aliases, source, references: roleReferenceTypes({ id, name, aliases }, state),
    }));
    return {
        roles: roster,
        referenceTypes: referenceTypes(state),
        portraitSync: {
            syncedAt: state.syncedAt,
            matched: roster.filter(role => role.references.some(ref => ref.type !== 'custom')).length,
        },
        themes: themes.map(({ id, name, source, reference, identities }) => ({
            id, name, source, reference, identities: identities.map(identity => identity.name),
        })),
    };
}
