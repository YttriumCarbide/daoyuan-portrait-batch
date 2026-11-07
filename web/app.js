const $ = id => document.getElementById(id);
const selected = new Set();
const identities = new Map();
const roleReferences = new Map();
let library = { roles: [], themes: [], referenceTypes: [], provider: false };
let visibleBatch = null;
let batchPoll;

function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
}

function notice(text, isError = false) {
    $('notice').textContent = text;
    $('notice').classList.toggle('error', isError);
}

async function request(path, data) {
    const response = await fetch('/api/' + path, data === undefined ? undefined : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    });
    if (!response.ok) throw new Error((await response.json()).error ?? '请求失败。');
    return response;
}

async function api(path, data) {
    return (await request(path, data)).json();
}

function handle(action) {
    return async event => {
        event.preventDefault();
        const button = event.submitter ?? (event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null);
        if (button) button.disabled = true;
        try {
            await action(event);
        } catch (error) {
            notice(error.message, true);
        } finally {
            if (button) button.disabled = button.id === 'run' && (
                visibleBatch?.running || !visibleBatch?.jobs.some(job => ['failed', 'pending'].includes(job.status))
            );
        }
    };
}

function option(value, label) {
    const element = node('option', label);
    element.value = value;
    return element;
}

function rolesForSearch() {
    const search = $('search').value.normalize('NFKC').trim().toLowerCase();
    return library.roles.filter(role =>
        [role.name, ...role.aliases].some(name => name.normalize('NFKC').toLowerCase().includes(search)));
}

function renderRoles() {
    const roles = rolesForSearch();
    $('role-list').replaceChildren(...roles.map(role => {
        const label = node('label', undefined, 'role-option');
        const box = node('input');
        box.type = 'checkbox';
        box.checked = selected.has(role.id);
        box.addEventListener('change', () => {
            if (box.checked) selected.add(role.id);
            else {
                selected.delete(role.id);
                identities.delete(role.id);
                roleReferences.delete(role.id);
            }
            renderSelected();
        });
        label.append(box, node('span', role.name), node('small', role.source));
        return label;
    }));
    if (!roles.length) $('role-list').append(node('p', library.roles.length ? '没有匹配的角色。' : '请先导入本体和工坊世界书。', 'muted'));
}

function imageInput(label, action) {
    const container = node('label', label, 'upload');
    const input = node('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.addEventListener('change', handle(async () => {
        const file = input.files[0];
        if (!file) return;
        if (file.size > 20 * 1024 * 1024) throw new Error('图片不能超过 20 MiB。');
        const bytes = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1]);
            reader.onerror = () => reject(new Error('无法读取图片。'));
            reader.readAsDataURL(file);
        });
        input.value = '';
        await action(bytes);
    }));
    container.append(input);
    return container;
}

function referenceName(type) {
    return library.referenceTypes.find(item => item.id === type)?.name ?? type;
}

function renderDefaultReference(theme) {
    const select = $('reference-default');
    const previous = select.value;
    const types = library.referenceTypes.filter(type => theme?.reference !== 'required' || type.id !== 'none');
    select.replaceChildren(...types.map(type => option(type.id, type.name)));
    select.value = types.some(type => type.id === previous) ? previous : 'default';
    $('reference-default-label').hidden = !theme || theme.reference === 'none';
}

async function previewReference(target, role, type) {
    target.replaceChildren(node('p', '正在下载预览…', 'muted'));
    try {
        const response = await request('reference-image', { role, type });
        const url = URL.createObjectURL(await response.blob());
        const image = node('img');
        image.alt = '人物参考图';
        image.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
        image.addEventListener('error', () => URL.revokeObjectURL(url), { once: true });
        image.src = url;
        target.replaceChildren(image);
    } catch (error) {
        target.replaceChildren(node('p', error.message, 'warning'));
    }
}

function renderRoleReference(role, theme) {
    const id = role.id;
    const row = node('div', undefined, 'reference-row');
    const choices = role.references;
    const select = node('select');
    select.setAttribute('aria-label', role.name + '的参考图类型');
    const batchType = $('reference-default').value;
    select.append(option('', '跟随整批（' + referenceName(batchType) + '）'));
    for (const { type, count } of choices) {
        select.append(option(type, referenceName(type) + (count > 1 ? ' · ' + count + ' 张' : '')));
    }
    if (theme.reference !== 'required') select.append(option('none', '不使用参考图'));
    const override = roleReferences.get(id);
    select.value = [...select.options].some(item => item.value === override) ? override : '';
    select.addEventListener('change', () => {
        if (select.value) roleReferences.set(id, select.value);
        else roleReferences.delete(id);
        renderSelected();
    });
    let type = select.value || batchType;
    const hasType = name => choices.some(choice => choice.type === name);
    if (!select.value && type === 'default' && !hasType(type) && hasType('custom')) type = 'custom';
    row.append(select);
    const preview = node('div', undefined, 'reference-preview');
    if (hasType(type)) {
        const button = node('button', '预览' + referenceName(type), 'text-button');
        button.type = 'button';
        button.addEventListener('click', handle(() => previewReference(preview, id, type)));
        row.append(button);
    } else if (type !== 'none') {
        row.append(node('span', '缺少' + referenceName(type), theme.reference === 'required' ? 'warning' : 'muted'));
    }
    const add = node('details', undefined, 'reference-tools');
    const saved = async data => {
        await api('reference', { role: id, ...data });
        if (selected.has(id)) roleReferences.set(id, 'custom');
        await refreshLibrary();
        notice('已下载或导入 ' + role.name + ' 的自定义参考图，可点击预览。');
    };
    const form = node('form');
    const url = node('input');
    url.type = 'url';
    url.required = true;
    url.placeholder = '粘贴 HTTPS 图片 URL';
    url.setAttribute('aria-label', role.name + '的参考图 URL');
    const save = node('button', '下载并绑定', 'secondary');
    save.type = 'submit';
    form.append(url, save);
    form.addEventListener('submit', handle(() => saved({ url: url.value.trim() })));
    add.append(node('summary', hasType('custom') ? '更换自定义参考图' : '添加参考图'),
        form, imageInput('或选择本地图片', image => saved({ image })));
    row.append(add, preview);
    return row;
}

function renderSelected() {
    const theme = library.themes.find(item => item.id === $('theme').value);
    const byId = new Map(library.roles.map(role => [role.id, role]));
    $('selected-count').textContent = '已选 ' + selected.size + ' 人';
    $('prompts').replaceChildren();
    $('selected').replaceChildren(...[...selected].map(id => {
        const role = byId.get(id);
        const row = node('div', undefined, 'selection');
        row.append(node('strong', role.name));
        if (theme?.identities.length) {
            const select = node('select');
            select.setAttribute('aria-label', role.name + '的学院身份');
            select.append(option('', '自动分配身份'), ...theme.identities.map(name => option(name, name)));
            select.value = identities.get(id) ?? '';
            select.addEventListener('change', () => {
                identities.set(id, select.value);
                $('prompts').replaceChildren();
            });
            row.append(select);
        }
        const remove = node('button', '移除', 'text-button');
        remove.type = 'button';
        remove.setAttribute('aria-label', '移除 ' + role.name);
        remove.addEventListener('click', () => {
            selected.delete(id);
            identities.delete(id);
            roleReferences.delete(id);
            renderRoles();
            renderSelected();
        });
        row.append(remove);
        if (theme && theme.reference !== 'none') row.append(renderRoleReference(role, theme));
        return row;
    }));
}

async function refreshLibrary(themeId = $('theme').value) {
    library = await api('library');
    for (const id of selected) {
        if (!library.roles.some(role => role.id === id)) {
            selected.delete(id);
            identities.delete(id);
            roleReferences.delete(id);
        }
    }
    $('theme').replaceChildren(...library.themes.map(theme => option(theme.id, theme.name + ' · ' + theme.source)));
    if (!library.themes.length) $('theme').append(option('', '请先导入世界书'));
    if (library.themes.some(theme => theme.id === themeId)) $('theme').value = themeId;
    const theme = library.themes.find(item => item.id === $('theme').value);
    for (const [id, type] of roleReferences) {
        const role = library.roles.find(item => item.id === id);
        if (type === 'none' ? theme?.reference === 'required' : !role?.references.some(item => item.type === type)) {
            roleReferences.delete(id);
        }
    }
    renderDefaultReference(theme);
    const { syncedAt, matched } = library.portraitSync;
    $('portrait-status').textContent = syncedAt
        ? '状态栏立绘已匹配 ' + matched + ' / ' + library.roles.length + ' 位角色'
        : '尚未同步状态栏立绘，可先导入自己的参考图。';
    $('library-count').textContent = library.roles.length + ' 人 · ' + library.themes.length + ' 个主题';
    $('mode').textContent = library.provider ? '已配置生图服务' : 'Codex 生图模式';
    $('queue').textContent = library.provider ? '创建并开始生图' : '创建批次';
    renderRoles();
    renderSelected();
}

function composition() {
    return {
        theme: $('theme').value, roles: [...selected], brief: $('brief').value, identities: Object.fromEntries(identities),
        referenceType: $('reference-default').value || 'default', roleReferences: Object.fromEntries(roleReferences),
    };
}

function showPrompts(data) {
    $('prompts').replaceChildren(...data.jobs.map(job => {
        const detail = node('details');
        const reference = job.referenceType === 'none' ? '' :
            ' · ' + (job.referenceUnavailable ? '缺少' : '') + referenceName(job.referenceType);
        const title = job.name + (job.identity ? ' · ' + job.identity : '') + reference;
        detail.append(node('summary', title, job.missingReference ? 'warning' : ''), node('pre', job.prompt));
        return detail;
    }));
    $('prompts').firstElementChild.open = true;
}

function runButton(text, batch, role) {
    const button = node('button', text, 'secondary');
    button.addEventListener('click', handle(async () => {
        await api('run', { batch, role });
        await refreshBatch();
    }));
    return button;
}

async function refreshBatches(id = $('batch').value) {
    const batches = await api('batches');
    $('batch').replaceChildren(...batches.map(item => option(item.id, item.theme + ' · ' + item.count + ' 人 · ' + item.id)));
    if (!batches.length) $('batch').append(option('', '暂无批次'));
    if (batches.some(item => item.id === id)) $('batch').value = id;
    await refreshBatch();
}

async function refreshBatch() {
    clearTimeout(batchPoll);
    const id = $('batch').value;
    if (!id) {
        visibleBatch = null;
        $('batch-actions').hidden = true;
        $('job-list').replaceChildren();
        $('batch-info').textContent = '创建批次后，可以在这里查看进度与成图。';
        return;
    }
    const batch = await api('batch?batch=' + encodeURIComponent(id));
    if (id !== $('batch').value) return;
    visibleBatch = batch;
    $('batch-actions').hidden = false;
    $('run').hidden = !library.provider;
    $('run').disabled = batch.running || !batch.jobs.some(job => ['failed', 'pending'].includes(job.status));
    const finished = batch.jobs.filter(job => job.status === 'done').length;
    $('batch-info').textContent = '已完成 ' + finished + ' / ' + batch.jobs.length + ' · ' + batch.path;
    const names = { pending: '待生成', running: '生成中', done: '已完成', failed: '失败' };
    $('job-list').replaceChildren(...batch.jobs.map(job => {
        const card = node('article', undefined, 'job');
        card.append(node('strong', job.name + (job.identity ? ' · ' + job.identity : '')), node('small', names[job.status]));
        if (job.referenceType && job.referenceType !== 'none') {
            card.append(node('small', (job.referenceUnavailable ? '缺少参考图 · ' : '参考图 · ') + referenceName(job.referenceType)));
        }
        if (job.error) card.append(node('p', job.error, 'warning'));
        const actions = node('div', undefined, 'actions');
        if (job.imagePath) {
            const src = '/api/image?' + new URLSearchParams({ batch: id, role: job.id });
            const image = node('img');
            image.src = src;
            image.alt = job.name + ' 立绘';
            image.loading = 'lazy';
            const link = node('a', '下载', 'download');
            link.href = src;
            link.download = job.imagePath.split(/[\\/]/u).at(-1);
            card.append(image);
            actions.append(link);
        } else if (job.status !== 'running') {
            actions.append(imageInput('导入成图', async image => {
                await api('complete', { batch: id, role: job.id, image });
                await refreshBatch();
            }));
            if (library.provider && !batch.running) actions.append(runButton(job.status === 'failed' ? '重跑' : '仅跑此人', id, job.id));
        }
        if (actions.childElementCount) card.append(actions);
        return card;
    }));
    if (finished < batch.jobs.length) {
        batchPoll = setTimeout(() => refreshBatch().catch(error => notice(error.message, true)), batch.running ? 2500 : 7000);
    }
}

$('import-form').addEventListener('submit', handle(async event => {
    const files = new FormData(event.currentTarget);
    const [world, workshop] = await Promise.all(['world', 'workshop'].map(async key =>
        JSON.parse((await files.get(key).text()).replace(/^\uFEFF/u, ''))));
    const result = await api('import', { world, workshop });
    identities.clear();
    await refreshLibrary();
    $('import-panel').open = false;
    notice('已导入 ' + result.roles + ' 位角色、' + result.themes + ' 个主题。');
}));

$('theme-form').addEventListener('submit', handle(async event => {
    const form = event.currentTarget;
    const theme = await api('theme', Object.fromEntries(new FormData(form)));
    form.reset();
    identities.clear();
    await refreshLibrary(theme.id);
    notice('已保存主题「' + theme.name + '」。');
}));

$('name-form').addEventListener('submit', handle(async () => {
    const names = $('names').value.split(/[、,，;\s]+/u).filter(Boolean);
    const normalize = text => text.normalize('NFKC').toLowerCase();
    const misses = [];
    for (const name of names) {
        const input = normalize(name);
        const exact = library.roles.filter(role => normalize(role.name) === input);
        const matches = exact.length ? exact : library.roles.filter(role => role.aliases.some(alias => normalize(alias) === input));
        if (matches.length === 1) selected.add(matches[0].id);
        else misses.push(name);
    }
    $('names').value = misses.join('、');
    renderRoles();
    renderSelected();
    notice(misses.length ? '未匹配或重名：' + misses.join('、') : '已添加名单。', Boolean(misses.length));
}));

$('search').addEventListener('input', renderRoles);
$('brief').addEventListener('input', () => $('prompts').replaceChildren());
$('theme').addEventListener('change', () => {
    identities.clear();
    const theme = library.themes.find(item => item.id === $('theme').value);
    if (theme?.reference === 'required') {
        for (const [id, type] of roleReferences) if (type === 'none') roleReferences.delete(id);
    }
    renderDefaultReference(theme);
    renderSelected();
});
$('reference-default').addEventListener('change', renderSelected);
$('sync-portraits').addEventListener('click', handle(async () => {
    notice('正在同步状态栏立绘索引…');
    const result = await api('portrait-sync', {});
    await refreshLibrary();
    notice('已同步状态栏立绘，匹配到 ' + result.matched + ' 位角色。');
}));
$('clear').addEventListener('click', () => {
    selected.clear(); identities.clear(); roleReferences.clear(); renderRoles(); renderSelected();
});
$('batch').addEventListener('change', handle(refreshBatch));
$('preview').addEventListener('click', handle(async () => showPrompts(await api('preview', composition()))));
$('queue').addEventListener('click', handle(async () => {
    notice('正在准备批次并下载所选参考图…');
    const batch = await api('queue', composition());
    await refreshBatches(batch.id);
    if (library.provider) {
        await api('run', { batch: batch.id });
        await refreshBatch();
    }
    notice('已创建 ' + batch.jobs.length + ' 项任务。');
}));
$('run').addEventListener('click', handle(async () => {
    await api('run', { batch: visibleBatch.id });
    await refreshBatch();
}));
$('handoff').addEventListener('click', handle(async () => {
    await navigator.clipboard.writeText('请按本工作区 AGENTS.md 运行道渊立绘批次 ' + visibleBatch.id + '，完成后汇报成图和失败项。');
    notice('已复制指令。请粘贴到以本文件夹为工作区的 Codex 聊天。');
}));

try {
    await refreshLibrary();
    $('import-panel').open = library.roles.length === 0;
    await refreshBatches();
} catch (error) {
    notice(error.message, true);
}
