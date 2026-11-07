import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadImage, httpsImageUrl } from './remote-image.mjs';
import { home, imageExtension, readJson, writeAtomic, writeJson } from './storage.mjs';

export const portraitSource = 'https://raw.githubusercontent.com/YttriumCarbide/Daoyuan/main/images.json';
export const defaultReferenceType = 'default';
const catalogPath = join(home, 'portraits.json');
const userDirectory = join(home, 'references');
const typePattern = /^[a-z][a-z0-9_-]{0,39}$/u;
const knownNames = {
    default: '常态立绘', special: '心动立绘', female: '性转', nai: 'NAI', jk: 'JK',
    magic: '魔法学院', real: '真人', tarot: '塔罗', qipao: '旗袍', child: '幼年',
    swimsuit: '泳装', wedding: '婚纱', custom: '自定义参考图', none: '不使用参考图',
};

export function referenceLabel(type) {
    return Object.hasOwn(knownNames, type) ? knownNames[type] : type;
}

function normalize(name) {
    return name.normalize('NFKC').trim().toLowerCase();
}

export function parsePortraitIndex(raw) {
    if (Number(raw?.schemaVersion) !== 2 || !raw.data?.entities || typeof raw.data.entities !== 'object') {
        throw new Error('状态栏立绘索引格式不受支持。');
    }
    const portraits = new Map();
    for (const [name, entity] of Object.entries(raw.data.entities)) {
        if (entity?.type !== 'character' || !Array.isArray(entity.images) || !name.trim()) continue;
        const types = new Map();
        for (const item of entity.images) {
            const theme = typeof item?.theme === 'string' ? normalize(item.theme) : '';
            const type = theme === 'normal' ? defaultReferenceType : theme;
            if (!typePattern.test(type) || ['none', 'custom'].includes(type)) continue;
            let url;
            try { url = httpsImageUrl(item.url).href; } catch { continue; }
            if (!types.has(type)) types.set(type, []);
            const urls = types.get(type);
            if (!urls.includes(url)) urls.push(url);
        }
        if (types.size) portraits.set(normalize(name), Object.fromEntries(types));
    }
    if (!portraits.size) throw new Error('状态栏索引没有可用的角色立绘。');
    return Object.fromEntries(portraits);
}

export async function syncPortraits() {
    const response = await fetch(portraitSource, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('状态栏立绘索引返回 HTTP ' + response.status + '。');
    const portraits = parsePortraitIndex(await response.json());
    const syncedAt = new Date().toISOString();
    await writeJson(catalogPath, { syncedAt, portraits });
    return syncedAt;
}

export async function loadReferences() {
    const [catalog, names] = await Promise.all([
        readJson(catalogPath, { portraits: {}, syncedAt: null }),
        readdir(userDirectory).catch(error => {
            if (error.code === 'ENOENT') return [];
            throw error;
        }),
    ]);
    return { ...catalog, custom: new Set(names) };
}

function rolePortraits(role, state) {
    const key = normalize(role.name);
    if (Object.hasOwn(state.portraits, key)) return state.portraits[key];
    const aliases = new Set(role.aliases.map(normalize).filter(name => Object.hasOwn(state.portraits, name)));
    if (aliases.size === 1) return state.portraits[[...aliases][0]];
    return {};
}

export function roleReferenceTypes(role, state) {
    const entries = Object.entries(rolePortraits(role, state)).map(([type, urls]) => ({ type, count: urls.length }));
    if (state.custom.has(role.id)) entries.push({ type: 'custom', count: 1 });
    return entries;
}

export function referenceTypes(state) {
    const types = new Set(['default']);
    for (const value of Object.values(state.portraits)) {
        for (const type of Object.keys(value)) types.add(type);
    }
    if (state.custom.size) types.add('custom');
    types.add('none');
    return [...types].map(id => ({ id, name: referenceLabel(id) }));
}

export function resolveReferenceType(state, value) {
    if (value === 'normal') return defaultReferenceType;
    if (value === 'custom' || value === referenceLabel('custom')) return 'custom';
    const type = referenceTypes(state).find(item => item.id === value || item.name === value);
    if (!type) throw new Error('未知参考图类型「' + value + '」。');
    return type.id;
}

export function chooseReference(role, state, type = defaultReferenceType, fallback = false) {
    if (type === 'none') return null;
    const portraits = rolePortraits(role, state);
    if (Object.hasOwn(portraits, type)) return { type, urls: portraits[type] };
    if (state.custom.has(role.id) && (type === 'custom' || (type === defaultReferenceType && fallback))) {
        return { type: 'custom', path: join(userDirectory, role.id) };
    }
    return null;
}

export async function storeReference(role, image) {
    const extension = imageExtension(image);
    const path = join(userDirectory, role.id);
    await writeAtomic(path, image);
    return { id: role.id, name: role.name, extension, path };
}

export async function loadReferenceImage(choice) {
    if (choice.path) {
        const bytes = await readFile(choice.path);
        return { bytes, extension: imageExtension(bytes), path: choice.path };
    }
    let lastError;
    for (const url of choice.urls) {
        const key = createHash('sha256').update(url).digest('hex');
        const path = join(home, 'portrait-cache', key);
        try {
            let bytes = await readFile(path).catch(error => {
                if (error.code === 'ENOENT') return null;
                throw error;
            });
            if (!bytes) {
                bytes = await downloadImage(url);
                await writeAtomic(path, bytes);
            }
            return { bytes, extension: imageExtension(bytes), path };
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError ?? new Error('该角色没有可下载的参考图。');
}
