// ============================================
// gallery.js — 图集：所有生成过的图都在这里，随时翻看
// 只存 ComfyUI 的 filename/subfolder/base，不存 base64，
// 所以设置文件不会膨胀，图也能长期复用。
// ============================================

import { save as saveSettings } from './settings.js';

let S = null;

function init(settings) { S = settings; }

const KIND_LABEL = { bg: '背景', char: '立绘', item: '物品', cg: '插画' };

export function urlOf(g) {
    if (!g || !g.base || !g.filename) return '';
    return g.base + '/view?filename=' + encodeURIComponent(g.filename) +
        '&subfolder=' + encodeURIComponent(g.subfolder || '') +
        '&type=' + encodeURIComponent(g.type || 'output');
}

export function addToGallery(item) {
    if (!S || !item || !item.filename) return;
    if (!Array.isArray(S.gallery)) S.gallery = [];
    const id = item.base + '|' + item.filename;
    if (S.gallery.some(g => (g.base + '|' + g.filename) === id)) return;
    S.gallery.unshift({
        kind: item.kind || 'cg',
        key: item.key || '',
        prompt: item.prompt || '',
        base: item.base,
        filename: item.filename,
        subfolder: item.subfolder || '',
        type: item.type || 'output',
        ts: Date.now(),
    });
    if (S.gallery.length > 240) S.gallery.length = 240;
    saveSettings();
}

export function list() { return (S && Array.isArray(S.gallery)) ? S.gallery : []; }

export function clearGallery() {
    if (!S) return;
    S.gallery = [];
    saveSettings();
}

// ---------- 图集页面 ----------
// host: 容器（theater 传进来的整块 body）
export function renderPage(host) {
    if (!host) return;
    const items = list();
    host.innerHTML = '';

    const bar = document.createElement('div');
    bar.className = 'vnl-gal-bar';
    bar.innerHTML = `<div class="vnl-gal-count">共 ${items.length} 张</div>`;
    const clr = document.createElement('button');
    clr.className = 'vnl-gal-clear';
    clr.textContent = '清空图集';
    clr.addEventListener('click', () => {
        if (!confirm('确定清空图集？已生成的图会从列表里移除（ComfyUI 里的文件不会删）。')) return;
        clearGallery();
        renderPage(host);
    });
    bar.appendChild(clr);
    host.appendChild(bar);

    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'vnl-gal-empty';
        empty.innerHTML = '还没有图。<br>开启「AI 绘图」后，背景 / 立绘 / 物品会在演出过程中自动生成。';
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
    box.querySelector('img').src = urlOf(it);
    const meta = box.querySelector('.vnl-gal-meta');
    meta.textContent = (it.key || '') + (it.prompt ? '\n' + it.prompt : '');
    box.addEventListener('click', e => {
        if (e.target === box || e.target.closest('.vnl-gal-close')) box.remove();
    });
    host.appendChild(box);
}
