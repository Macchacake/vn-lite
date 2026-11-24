// ============================================
// gallery.js — 图集：所有生成过的图都在这里，随时翻看
// 只存 ComfyUI 的 filename/subfolder/base，不存 base64，
// 所以设置文件不会膨胀，图也能长期复用。
// ============================================

import { save as saveSettings } from './settings.js';
import { applyChroma } from './chroma.js';
import * as localstore from './localstore.js';
import { getChatKey } from './session.js';

let S = null;

export function init(settings) { S = settings; }

const KIND_LABEL = { bg: '背景', char: '立绘', item: '物品', cg: '插画' };

export function urlOf(g) {
    if (!g || !g.filename) return '';
    // 本地副本优先（隧道关掉也能看图）
    const localId = g.localId || (g.kind && g.key ? (getChatKey() + '::' + g.kind + '|' + g.key) : null);
    const local = localId ? localstore.peekUrl(localId) : null;
    if (local) return local;
    if (!g.base) return '';
    return g.base + '/view?filename=' + encodeURIComponent(g.filename) +
        '&subfolder=' + encodeURIComponent(g.subfolder || '') +
        '&type=' + encodeURIComponent(g.type || 'output');
}

export function addToGallery(item) {
    if (!S || !item || !item.filename) return;
    if (!Array.isArray(S.gallery)) S.gallery = [];
    const chat = getChatKey();
    const id = item.base + '|' + item.filename;
    // 同一张图在同一段对话里只记一次；跨对话各自保留一份
    if (S.gallery.some(g => (g.base + '|' + g.filename) === id && (g.chat || 'default') === chat)) return;
    S.gallery.unshift({
        kind: item.kind || 'cg',
        key: item.key || '',
        prompt: item.prompt || '',
        base: item.base,
        filename: item.filename,
        subfolder: item.subfolder || '',
        type: item.type || 'output',
        localId: item.localId || '',
        chat,
        ts: Date.now(),
    });
    if (S.gallery.length > 480) S.gallery.length = 480;
    saveSettings();
}

// 只返回当前对话的图集：切到别的对话看不到这段对话的历史生图
export function list() {
    if (!S || !Array.isArray(S.gallery)) return [];
    const chat = getChatKey();
    return S.gallery.filter(g => (g.chat || 'default') === chat);
}

// 图片 404 / ComfyUI 换了地址 → 从图集里剔掉，别留一格空白
export function removeFromGallery(item) {
    if (!S || !Array.isArray(S.gallery) || !item) return;
    const id = item.base + '|' + item.filename;
    const chat = getChatKey();
    const before = S.gallery.length;
    S.gallery = S.gallery.filter(g => !((g.base + '|' + g.filename) === id && (g.chat || 'default') === chat));
    if (S.gallery.length !== before) saveSettings();
    if (item.localId) localstore.remove(item.localId);
}

// 只清当前对话的图集（含本地文件），不动别的对话
export function clearGallery() {
    if (!S) return;
    const chat = getChatKey();
    const mine = S.gallery.filter(g => (g.chat || 'default') === chat);
    S.gallery = S.gallery.filter(g => (g.chat || 'default') !== chat);
    saveSettings();
    for (const g of mine) if (g.localId) localstore.remove(g.localId);
}

// ---------- 图集页面 ----------
// host: 容器（theater 传进来的整块 body）
export function renderPage(host) {
    if (!host) return;
    const items = list();
    host.innerHTML = '';

    const bar = document.createElement('div');
    bar.className = 'vnl-gal-bar';
    bar.innerHTML = `<div class="vnl-gal-count">本对话 ${items.length} 张（只显示当前对话的图）</div>`;
    const clr = document.createElement('button');
    clr.className = 'vnl-gal-clear';
    clr.textContent = '清空本对话图集';
    clr.addEventListener('click', () => {
        if (!confirm('确定清空当前对话的图集？只删除本对话的记录和手机本地副本，不影响其它对话，也不删 ComfyUI 上的文件。')) return;
        clearGallery();
        renderPage(host);
    });
    bar.appendChild(clr);
    host.appendChild(bar);

    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'vnl-gal-empty';
        empty.innerHTML = '这段对话还没有图。<br>开启「AI 绘图」后，背景 / 立绘 / 物品会在演出过程中自动生成，并自动下载到手机本地。<br>切到别的对话只会看到那段对话自己的图。';
        host.appendChild(empty);
        return;
    }

    const grid = document.createElement('div');
    grid.className = 'vnl-gal-grid';
    for (const it of items) {
        const cell = document.createElement('button');
        cell.className = 'vnl-gal-cell';
        cell.type = 'button';
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = urlOf(it);
        img.alt = it.key || it.kind;
        img.addEventListener('error', () => {
            cell.remove();
            removeFromGallery(it);
        });
        // 立绘按透明底显示（棋盘格衬底），跟舞台一致
        if (it.kind === 'char' && S && S.portraitAlpha) {
            cell.classList.add('vnl-gal-alpha');
            applyChroma(img, urlOf(it));
        }
        const tag = document.createElement('span');
        tag.className = 'vnl-gal-tag';
        tag.textContent = (KIND_LABEL[it.kind] || '图') + (it.key ? ' · ' + it.key : '');
        cell.append(img, tag);
        cell.addEventListener('click', () => openLightbox(host, it));
        grid.appendChild(cell);
    }
    host.appendChild(grid);
}

function openLightbox(host, it) {
    const box = document.createElement('div');
    box.className = 'vnl-gal-light';
    box.innerHTML = `
        <div class="vnl-gal-light-inner">
            <img alt="preview">
            <div class="vnl-gal-meta"></div>
            <button class="vnl-menu-btn vnl-gal-close">关闭</button>
        </div>`;
    const bigImg = box.querySelector('img');
    bigImg.src = urlOf(it);
    if (it.kind === 'char' && S && S.portraitAlpha) {
        box.querySelector('.vnl-gal-light-inner').classList.add('vnl-gal-alpha');
        applyChroma(bigImg, urlOf(it));
    }
    const meta = box.querySelector('.vnl-gal-meta');
    meta.textContent = (it.key || '') + (it.prompt ? '\n' + it.prompt : '');
    box.addEventListener('click', e => {
        if (e.target === box || e.target.closest('.vnl-gal-close')) box.remove();
    });
    host.appendChild(box);
}
