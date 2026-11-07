const $ = id => document.getElementById(id);
const selected = new Set();
const identities = new Map();
let library = { roles: [], themes: [], provider: false };
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

async function api(path, data) {
    const response = await fetch('/api/' + path, data === undefined ? undefined : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? '请求失败。');
    return value;
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
        if (theme && theme.reference !== 'none') {
            const label = role.hasReference ? '换参考图' : (theme.reference === 'required' ? '绑定参考图（必需）' : '绑定参考图');
            row.append(imageInput(label, async image => {
                await api('reference', { role: id, image });
                role.hasReference = true;
                renderSelected();
                notice('已保存 ' + role.name + ' 的参考图。');
            }));
        }
        const remove = node('button', '移除', 'text-button');
        remove.type = 'button';
        remove.setAttribute('aria-label', '移除 ' + role.name);
        remove.addEventListener('click', () => {
            selected.delete(id);
            identities.delete(id);
            renderRoles();
            renderSelected();
        });
        row.append(remove);
        return row;
    }));
}

async function refreshLibrary(themeId = $('theme').value) {
    library = await api('library');
    for (const id of selected) {
        if (!library.roles.some(role => role.id === id)) {
            selected.delete(id);
            identities.delete(id);
        }
    }
    $('theme').replaceChildren(...library.themes.map(theme => option(theme.id, theme.name + ' · ' + theme.source)));
    if (!library.themes.length) $('theme').append(option('', '请先导入世界书'));
    if (library.themes.some(theme => theme.id === themeId)) $('theme').value = themeId;
    $('library-count').textContent = library.roles.length + ' 人 · ' + library.themes.length + ' 个主题';
    $('mode').textContent = library.provider ? '已配置生图服务' : 'Codex 生图模式';
    $('queue').textContent = library.provider ? '创建并开始生图' : '创建批次';
    renderRoles();
    renderSelected();
}

function composition() {
    return { theme: $('theme').value, roles: [...selected], brief: $('brief').value, identities: Object.fromEntries(identities) };
}

function showPrompts(data) {
    $('prompts').replaceChildren(...data.jobs.map(job => {
        const detail = node('details');
        const title = job.name + (job.identity ? ' · ' + job.identity : '') + (job.missingReference ? ' · 缺参考图' : '');
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
$('theme').addEventListener('change', () => { identities.clear(); renderSelected(); });
$('clear').addEventListener('click', () => { selected.clear(); identities.clear(); renderRoles(); renderSelected(); });
$('batch').addEventListener('change', handle(refreshBatch));
$('preview').addEventListener('click', handle(async () => showPrompts(await api('preview', composition()))));
$('queue').addEventListener('click', handle(async () => {
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
