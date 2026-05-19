// ==UserScript==
// @name         ChatGPT → Notion（保留公式｜数据库支持｜修复列表与代码语言｜按钮置底不显设置）
// @namespace    https://github.com/wtnan2003/gpt2notion
// @version      1.2.12
// @description  将 ChatGPT 回答复制/推送到 Notion，并保留 LaTeX；支持父级为 Page/Database；修复列表、代码语言与 Markdown 管道表格识别。
// @author       you
// @match        https://chat.openai.com/*
// @match        https://chatgpt.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      api.notion.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const NOTION_API = 'https://api.notion.com/v1';
  const NOTION_VERSION = '2022-06-28';

  // ===== 工具函数 =====
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function nowTitle() {
    const d = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    return `ChatGPT 导出 ${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  function normalizeNotionId(input) {
    if (!input) return '';
    let s = String(input).trim();
    s = s.split('?')[0].split('#')[0];
    try { const u = new URL(s); s = u.pathname; } catch (e) {}
    const hy = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (hy) return hy[0].toLowerCase();
    const pl = s.match(/[0-9a-f]{32}/i);
    if (pl) {
      const p = pl[0].toLowerCase();
      return [p.slice(0,8),p.slice(8,12),p.slice(12,16),p.slice(16,20),p.slice(20)].join('-');
    }
    return '';
  }

  function getConfig() {
    return {
      token: GM_getValue('notion_token', ''),
      parentIdRaw: GM_getValue('notion_parent_id', ''),
      parentIsDatabase: GM_getValue('notion_parent_is_database', false),
      preferCreateNewPage: GM_getValue('notion_prefer_create_page', true),
      appendTargetIdRaw: GM_getValue('notion_append_target_id', ''),
    };
  }

  function setConfig(cfg) {
    if (cfg.token != null) GM_setValue('notion_token', cfg.token);
    if (cfg.parentIdRaw != null) GM_setValue('notion_parent_id', cfg.parentIdRaw);
    if (cfg.parentIsDatabase != null) GM_setValue('notion_parent_is_database', cfg.parentIsDatabase);
    if (cfg.preferCreateNewPage != null) GM_setValue('notion_prefer_create_page', cfg.preferCreateNewPage);
    if (cfg.appendTargetIdRaw != null) GM_setValue('notion_append_target_id', cfg.appendTargetIdRaw);
  }

  function notify(msg, type = 'info') {
    const id = 'tm-gpt2notion-toast';
    let div = document.getElementById(id);
    if (!div) {
      div = document.createElement('div');
      div.id = id;
      document.body.appendChild(div);
    }
    div.textContent = msg;
    div.className = `tm-toast ${type}`;
    div.style.display = 'block';
    setTimeout(() => (div.style.display = 'none'), 3000);
  }

  // ===== 样式：按钮置底；隐藏设置按钮（仅保留复制与推送） =====
  GM_addStyle(`
    .tm-export-bar { position: static; margin-top: 8px; z-index: 1000; display: flex; gap: 8px; }
    .tm-btn { cursor: pointer; padding: 6px 10px; border-radius: 8px; border: 1px solid #ddd; background: #fafafa; font-size: 12px; }
    .tm-btn:hover { background: #f0f0f0; }
    .tm-toast { position: fixed; right: 16px; bottom: 16px; padding: 10px 14px; border-radius: 10px; color: #fff; background: rgba(0,0,0,0.7); font-size: 13px; }
    .tm-toast.success { background: #16a34a; }
    .tm-toast.error { background: #dc2626; }
    .tm-panel { position: fixed; right: 16px; top: 16px; width: 340px; background: #fff; border: 1px solid #ddd; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.15); padding: 12px; z-index: 9999; }
    .tm-panel h3 { margin: 0 0 8px; font-size: 14px; }
    .tm-panel label { display:block; font-size:12px; color:#555; margin-top:8px; }
    .tm-panel input[type="text"], .tm-panel input[type="password"] { width:100%; box-sizing: border-box; padding:8px; border:1px solid #ddd; border-radius:8px; }
    .tm-row { display:flex; gap:8px; margin-top:10px; align-items:center; }
  `);

  // ===== Notion 请求封装 =====
  function notionRequest({ method, url, headers = {}, data }) {
    const cfg = getConfig();
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: `${NOTION_API}${url}`,
        data: data ? JSON.stringify(data) : undefined,
        headers: {
          'Authorization': `Bearer ${cfg.token}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
          ...headers,
        },
        onload: (res) => {
          try {
            const obj = JSON.parse(res.responseText || '{}');
            if (res.status >= 200 && res.status < 300) resolve(obj);
            else reject(new Error(`${res.status}: ${obj.message || res.responseText}`));
          } catch (e) {
            if (res.status >= 200 && res.status < 300) resolve({});
            else reject(new Error(`${res.status}: ${res.responseText}`));
          }
        },
        onerror: (e) => reject(e),
      });
    });
  }

  const NOTION_CHILD_LIMIT = 100;

  function chunkChildren(children, size = NOTION_CHILD_LIMIT) {
    const arr = Array.isArray(children) ? children : [];
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks;
  }

  async function appendChildren(targetId, children) {
    const chunks = chunkChildren(children);
    let lastRes = null;
    for (const chunk of chunks) {
      if (!chunk.length) continue;
      lastRes = await notionRequest({ method: 'PATCH', url: `/blocks/${targetId}/children`, data: { children: chunk } });
    }
    return lastRes;
  }

  async function createPageWithBlocks(title, children) {
    const cfg = getConfig();
    if (!cfg.token) throw new Error('未配置 Notion Token');

    const parentId = normalizeNotionId(cfg.parentIdRaw);
    const appendId = normalizeNotionId(cfg.appendTargetIdRaw);

    if (!parentId && !appendId) throw new Error('未配置 Notion 目标：请填写父页面/数据库 ID，或要追加的页面/块 ID');

    if (cfg.preferCreateNewPage) {
      if (!parentId) throw new Error('未配置父级 ID（页面或数据库）');
      const parent = cfg.parentIsDatabase ? { database_id: parentId } : { page_id: parentId };
      const chunks = chunkChildren(children);
      const firstChunk = chunks.length ? chunks.shift() : [];
      const payload = {
        parent,
        properties: cfg.parentIsDatabase
          ? undefined
          : { title: { title: [{ type: 'text', text: { content: title } }] } },
      };
      if (firstChunk.length) payload.children = firstChunk;
      const page = await notionRequest({ method: 'POST', url: '/pages', data: payload });
      if (page?.id && chunks.length) await appendChildren(page.id, chunks.flat());
      return page;
    } else {
      if (!appendId) throw new Error('未配置“追加到页面/块 ID”');
      const res = await appendChildren(appendId, children).catch(e => {
        if (/database/i.test(String(e))) throw new Error('“追加到”目标看起来像数据库 ID。请改用“创建新页面”并将父级设置为该数据库。');
        throw e;
      });
      return res;
    }
  }

  // ===== DOM 选择器适配 =====
  const MESSAGE_TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const ASSISTANT_ROLE_SELECTOR = '[data-message-author-role="assistant"]';

  function uniqueElements(nodes) {
    return Array.from(new Set(Array.from(nodes).filter(Boolean)));
  }

  function isAssistantMessageNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    const el = /** @type {HTMLElement} */(node);
    if (el.matches(ASSISTANT_ROLE_SELECTOR)) return true;
    const roleNode = el.querySelector(ASSISTANT_ROLE_SELECTOR);
    if (roleNode) return true;
    return !!el.querySelector('.markdown, .deep-research-result');
  }

  function findMessageNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
    const el = /** @type {HTMLElement} */(node);
    return el.closest(MESSAGE_TURN_SELECTOR) ||
      el.closest('article') ||
      el.closest('[data-message-id]') ||
      el.closest(ASSISTANT_ROLE_SELECTOR) ||
      el;
  }

  function getMessageContentRoot(msgNode) {
    return getMessageContentRoots(msgNode)[0] || msgNode;
  }

  function getMessageContentRoots(msgNode) {
    if (!msgNode) return null;
    const roleRoot = msgNode.matches?.(ASSISTANT_ROLE_SELECTOR)
      ? msgNode
      : msgNode.querySelector?.(ASSISTANT_ROLE_SELECTOR);
    const scope = roleRoot || msgNode;
    const roots = uniqueElements([
      ...Array.from(scope.querySelectorAll?.('.deep-research-result, .markdown') || []),
      ...Array.from(msgNode.querySelectorAll?.('.deep-research-result, .markdown') || []),
    ]).filter(el => !el.closest('.tm-export-bar'));
    const topRoots = roots.filter(el => !roots.some(other => other !== el && other.contains(el)));
    return topRoots.length ? topRoots : [scope];
  }

  function isContentBlockElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = el.tagName;
    if (isCodeBlockElement(el)) return true;
    return /^H[1-6]$/.test(tag) ||
      ['P', 'UL', 'OL', 'BLOCKQUOTE', 'HR', 'TABLE'].includes(tag) ||
      el.classList.contains('katex-display');
  }

  function isCodeBlockElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = el.tagName;
    if (tag === 'PRE') return true;
    if (tag === 'CODE') {
      const parentTag = el.parentElement?.tagName || '';
      return parentTag !== 'P' && getVisibleText(el).includes('\n');
    }
    if (tag !== 'DIV') return false;
    if (hasContentDescendantOutsideCode(el)) return false;
    if (el.matches('[data-message-code-block], [data-testid*="code"], [class*="code-block"]')) return true;
    const code = el.querySelector(':scope code');
    if (!code) return false;
    const text = getVisibleText(code);
    return text.includes('\n') || !!el.querySelector('button, [data-language], [class*="language-"]');
  }

  function hasContentDescendantOutsideCode(el) {
    const selector = 'h1,h2,h3,h4,h5,h6,p,ul,ol,blockquote,hr,table,.katex-display';
    return Array.from(el.querySelectorAll(selector)).some(node => {
      if (node === el) return false;
      return !node.closest('pre, code');
    });
  }

  function getVisibleText(el) {
    if (!el) return '';
    const inner = typeof el.innerText === 'string' ? el.innerText : '';
    const raw = inner || el.textContent || '';
    return raw.replace(/\r\n?/g, '\n').replace(/\u00A0/g, ' ');
  }

  function isKnownCodeLanguage(lang) {
    if (!lang) return false;
    const mapped = mapToNotionLang(lang);
    return mapped && mapped !== 'plain text';
  }

  function cleanLanguageLabel(label) {
    return String(label || '')
      .trim()
      .replace(/^language[-:\s]*/i, '')
      .replace(/\s+code$/i, '')
      .trim();
  }

  function inferCodeLanguageFromContainer(el, code) {
    const attrCandidates = [
      code?.getAttribute('data-language'),
      code?.getAttribute('data-lang'),
      el.getAttribute?.('data-language'),
      el.getAttribute?.('data-lang'),
      el.querySelector?.('[data-language]')?.getAttribute('data-language'),
      el.querySelector?.('[data-lang]')?.getAttribute('data-lang'),
    ].map(cleanLanguageLabel);
    const attrLang = attrCandidates.find(isKnownCodeLanguage);
    if (attrLang) return attrLang;

    const ignored = new Set(['copy', 'copy code', 'copied', '复制', '复制代码', '已复制', 'run', 'download']);
    const labelNodes = Array.from(el.querySelectorAll?.('span, div, figcaption') || []);
    for (const node of labelNodes) {
      if (node === code || node.contains(code) || node.closest('button')) continue;
      const label = cleanLanguageLabel(getVisibleText(node));
      if (!label || label.length > 32 || label.includes('\n')) continue;
      if (ignored.has(label.toLowerCase())) continue;
      const firstToken = cleanLanguageLabel(label.split(/\s+/)[0]);
      if (isKnownCodeLanguage(label)) return label;
      if (isKnownCodeLanguage(firstToken)) return firstToken;
    }
    return '';
  }

  function getCodeInfo(el) {
    const code = el.querySelector?.('code') || (el.tagName === 'CODE' ? el : null);
    const cls = Array.from(code?.classList || []);
    const fromClass = cls.find(c => c.startsWith('language-'))?.replace('language-', '') || '';
    const lang = fromClass ||
      code?.getAttribute('data-language') ||
      code?.getAttribute('data-lang') ||
      el.getAttribute?.('data-language') ||
      el.getAttribute?.('data-lang') ||
      el.querySelector?.('[data-language]')?.getAttribute('data-language') ||
      el.querySelector?.('[data-lang]')?.getAttribute('data-lang') ||
      inferCodeLanguageFromContainer(el, code) ||
      '';
    const textFromCode = code ? getVisibleText(code) : '';
    const text = textFromCode || getVisibleText(el);
    return { lang: cleanLanguageLabel(lang), text: text.replace(/\n$/, '') };
  }

  function collectContentBlocks(root) {
    const out = [];
    function walk(node) {
      if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
      const el = /** @type {HTMLElement} */(node);
      if (el.closest('.tm-export-bar')) return;
      if (isContentBlockElement(el)) {
        out.push(el);
        return;
      }
      Array.from(el.children).forEach(walk);
    }
    Array.from(root.children || []).forEach(walk);
    return out;
  }

  function getAssistantMessageNodes() {
    const set = new Set();
    document.querySelectorAll(`${MESSAGE_TURN_SELECTOR}, ${ASSISTANT_ROLE_SELECTOR}, .markdown, .deep-research-result`).forEach(node => {
      const msgNode = findMessageNode(node);
      if (msgNode && isAssistantMessageNode(msgNode)) set.add(msgNode);
    });
    return uniqueElements(set);
  }

  function ensureBar(msgNode) {
    if (!msgNode) return;
    const mark = 'tm-export-bar';
    if (msgNode.querySelector(`.${mark}`)) return;

    const bar = document.createElement('div');
    bar.className = mark + ' tm-export-bar';

    const btnCopy = document.createElement('button');
    btnCopy.className = 'tm-btn';
    btnCopy.textContent = '📋 copyMarkdown';
    btnCopy.addEventListener('click', async () => {
      try {
        const md = serializeToMarkdown(msgNode);
        await navigator.clipboard.writeText(md);
        notify('已复制 Markdown 到剪贴板', 'success');
      } catch (e) {
        console.error(e);
        notify('复制失败：' + e.message, 'error');
      }
    });

    const btnNotion = document.createElement('button');
    btnNotion.className = 'tm-btn';
    btnNotion.textContent = '🧭 sendNotion';
    btnNotion.addEventListener('click', async () => {
      try {
        const blocks = serializeToNotionBlocks(msgNode);
        const firstHeading = extractFirstHeadingText(msgNode) || nowTitle();
        notify('正在推送到 Notion...');
        const page = await createPageWithBlocks(firstHeading, blocks);
        const url = page?.url || '（已完成）';
        notify('推送完成，可到 Notion 查看', 'success');
        if (url && url.startsWith('http')) window.open(url, '_blank');
      } catch (e) {
        console.error(e);
        notify('推送失败：' + e.message, 'error');
      }
    });

    // 仅保留两个按钮（隐藏设置按钮）
    bar.appendChild(btnCopy);
    bar.appendChild(btnNotion);

    // 插入位置：使用整条消息容器，避免 ChatGPT 重绘 markdown 内部节点时移除按钮。
    const target = msgNode;
    target.appendChild(bar);
  }

  function openConfigPanel() {
    const cfg = getConfig();
    const panel = document.createElement('div');
    panel.className = 'tm-panel';
    panel.innerHTML = `
      <h3>Notion 设置</h3>
      <label>Notion Internal Integration Token（以 secret_ 开头）</label>
      <input id="tm-notion-token" type="password" placeholder="secret_xxx" value="${cfg.token || ''}" />
      <label>父级 ID（可直接粘贴 Notion 页面或数据库的完整链接，我会自动提取）</label>
      <input id="tm-notion-parent" type="text" placeholder="页面或数据库链接 / ID" value="${cfg.parentIdRaw || ''}" />
      <div class="tm-row">
        <label style="display:flex;align-items:center;gap:6px;"> <input id="tm-notion-parent-db" type="checkbox" ${cfg.parentIsDatabase ? 'checked' : ''}/> 父级是数据库（Database）</label>
      </div>
      <label>（可选）直接追加到页面/块 ID（不可为数据库；可粘贴完整链接）</label>
      <input id="tm-notion-append" type="text" placeholder="页面/块链接 或 ID" value="${cfg.appendTargetIdRaw || ''}" />
      <div class="tm-row">
        <label style="display:flex;align-items:center;gap:6px;">
          <input id="tm-notion-newpage" type="checkbox" ${cfg.preferCreateNewPage ? 'checked' : ''}/> 每次创建新页面（否则追加到上面指定页面/块）
        </label>
        <div style="flex:1"></div>
        <button id="tm-notion-save" class="tm-btn">保存</button>
        <button id="tm-notion-close" class="tm-btn">关闭</button>
      </div>
      <div style="font-size:12px;color:#666;margin-top:8px;line-height:1.4;">
        提示：1) 在 Notion「设置 → 集成」创建 Internal Integration，并把父页面/数据库 <b>Share → Invite</b> 给该集成；
        2) 可直接粘贴带 <code>?v=</code> 的数据库视图链接，我会自动提取 ID；
        3) 想把内容作为条目进数据库，请勾选“父级是数据库”。
      </div>
    `;
    document.body.appendChild(panel);

    panel.querySelector('#tm-notion-close').onclick = () => panel.remove();
    panel.querySelector('#tm-notion-save').onclick = () => {
      const token = /** @type {HTMLInputElement} */(panel.querySelector('#tm-notion-token')).value.trim();
      const parentIdRaw = /** @type {HTMLInputElement} */(panel.querySelector('#tm-notion-parent')).value.trim();
      const appendTargetIdRaw = /** @type {HTMLInputElement} */(panel.querySelector('#tm-notion-append')).value.trim();
      const newPage = /** @type {HTMLInputElement} */(panel.querySelector('#tm-notion-newpage')).checked;
      const parentIsDatabase = /** @type {HTMLInputElement} */(panel.querySelector('#tm-notion-parent-db')).checked;
      setConfig({ token, parentIdRaw, appendTargetIdRaw, preferCreateNewPage: newPage, parentIsDatabase });
      notify('配置已保存', 'success');
    };
  }

  // 菜单入口（隐藏设置按钮时仍可从这里打开）
  GM_registerMenuCommand('Notion 设置', openConfigPanel);

  // ====== 复制为 Markdown（保留 $ 与 $$） ======
  function serializeToMarkdown(msgNode) {
    const mdLines = [];
    const roots = getMessageContentRoots(msgNode) || [msgNode];

    function getLatexFromKatex(el) {
      const ann = el.querySelector('annotation[encoding="application/x-tex"]');
      return ann ? ann.textContent : '';
    }

    function textFromNode(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const el = /** @type {HTMLElement} */(node);
      if (el.matches('span.katex, .katex')) {
        const isDisplay = el.classList.contains('katex-display') || el.closest('.katex-display');
        const tex = getLatexFromKatex(el);
        return isDisplay ? `\n\n$$${tex}$$\n\n` : `$${tex}$`;
      }
      if (el.tagName === 'BR') return '  \n';
      if (el.tagName === 'CODE' && el.parentElement && el.parentElement.tagName !== 'PRE') {
        return '`' + Array.from(el.childNodes).map(textFromNode).join('') + '`';
      }
      if (el.tagName === 'STRONG' || el.tagName === 'B') {
        return '**' + Array.from(el.childNodes).map(textFromNode).join('') + '**';
      }
      if (el.tagName === 'EM' || el.tagName === 'I') {
        return '*' + Array.from(el.childNodes).map(textFromNode).join('') + '*';
      }
      if (el.tagName === 'A') {
        const txt = Array.from(el.childNodes).map(textFromNode).join('');
        const href = el.getAttribute('href') || '';
        return `[${txt}](${href})`;
      }
      return Array.from(el.childNodes).map(textFromNode).join('');
    }

    function handleBlock(el) {
      const tag = el.tagName;
      if (/^H[1-6]$/.test(tag)) {
        const level = parseInt(tag.substring(1), 10);
        mdLines.push('#'.repeat(level) + ' ' + textFromNode(el));
        mdLines.push('');
        return;
      }
      if (tag === 'P') {
        const markdownTable = parseMarkdownTable(getVisibleText(el));
        if (markdownTable) {
          mdLines.push(markdownTableToMarkdown(markdownTable));
          mdLines.push('');
          return;
        }
        const displayKatex = el.querySelector('.katex-display');
        if (displayKatex && el.textContent.trim() === displayKatex.textContent.trim()) {
          const tex = displayKatex.querySelector('annotation[encoding="application/x-tex"]').textContent;
          mdLines.push('');
          mdLines.push('$$' + tex + '$$');
          mdLines.push('');
          return;
        }
        mdLines.push(textFromNode(el));
        mdLines.push('');
        return;
      }
      if (isCodeBlockElement(el)) {
        const { lang, text } = getCodeInfo(el);
        const markdownTable = parseMarkdownTable(text || '');
        if (markdownTable) {
          mdLines.push(markdownTableToMarkdown(markdownTable));
        } else {
          mdLines.push('```' + (lang || ''));
          mdLines.push(text || '');
          mdLines.push('```');
        }
        mdLines.push('');
        return;
      }
      if (tag === 'UL' || tag === 'OL') {
        const ordered = tag === 'OL';
        Array.from(el.children).forEach((li, i) => {
          const line = (ordered ? (i + 1) + '. ' : '- ') + textFromNode(li);
        mdLines.push(line);
        });
        mdLines.push('');
        return;
      }
      if (tag === 'BLOCKQUOTE') {
        const inner = Array.from(el.childNodes).map(textFromNode).join('');
        inner.split(/\n/).forEach(l => mdLines.push('> ' + l));
        mdLines.push('');
        return;
      }
      if (tag === 'HR') {
        mdLines.push('---');
        mdLines.push('');
        return;
      }
      if (tag === 'TABLE') {
        mdLines.push(tableToMarkdown(el));
        mdLines.push('');
        return;
      }
      mdLines.push(textFromNode(el));
      mdLines.push('');
    }

    roots.forEach(root => {
      const contentBlocks = collectContentBlocks(root);
      if (contentBlocks.length) contentBlocks.forEach(handleBlock);
      else if (root.innerText && root.innerText.trim()) {
        mdLines.push(root.innerText.trim());
        mdLines.push('');
      }
    });
    return mdLines.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  // ====== Notion 语言映射 ======
  function mapToNotionLang(lang) {
    if (!lang) return 'plain text';
    const l = String(lang).toLowerCase();
    const alias = {
      js: 'javascript', node: 'javascript', mjs: 'javascript', cjs: 'javascript',
      ts: 'typescript',
      py: 'python',
      rb: 'ruby',
      kt: 'kotlin',
      rs: 'rust',
      sh: 'shell', zsh: 'shell', bash: 'bash',
      ps: 'powershell', ps1: 'powershell',
      cs: 'c#', csharp: 'c#',
      cpp: 'c++', cplusplus: 'c++',
      objc: 'objective-c', objectivec: 'objective-c',
      tex: 'latex',
      md: 'markdown',
      yml: 'yaml',
      json5: 'json',
      dockerfile: 'docker',
      make: 'makefile',
      m: 'matlab',
      txt: 'plain text', text: 'plain text', plaintext: 'plain text',
    };
    if (alias[l]) return alias[l];
    const allowed = new Set([
      'abap','abc','agda','arduino','ascii art','assembly','bash','basic','bnf','c','c#','c++',
      'clojure','coffeescript','coq','css','dart','dhall','diff','docker','ebnf','elixir','elm',
      'erlang','f#','flow','fortran','gherkin','glsl','go','graphql','groovy','haskell','hcl',
      'html','idris','java','javascript','json','julia','kotlin','latex','less','lisp','livescript',
      'llvm ir','lua','makefile','markdown','markup','matlab','mathematica','mermaid','nix',
      'notion formula','objective-c','ocaml','pascal','perl','php','plain text','powershell',
      'prolog','protobuf','purescript','python','r','racket','reason','ruby','rust','sass','scala',
      'scheme','scss','shell','smalltalk','solidity','sql','swift','toml','typescript','vb.net',
      'verilog','vhdl','visual basic','webassembly','xml','yaml','java/c/c++/c#'
    ]);
    return allowed.has(l) ? l : 'plain text';
  }

  // ====== 序列化为 Notion Blocks（保留 inline/display 公式） ======
  function serializeToNotionBlocks(msgNode) {
    const roots = getMessageContentRoots(msgNode) || [msgNode];
    const blocks = [];

    function rtText(content, annotations = {}, link = null) {
      return { type: 'text', text: { content, link: link ? { url: link } : null }, annotations: {
        bold: !!annotations.bold,
        italic: !!annotations.italic,
        strikethrough: !!annotations.strikethrough,
        underline: !!annotations.underline,
        code: !!annotations.code,
        color: annotations.color || 'default'
      } };
    }

    function rtCodeText(content) {
      return { type: 'text', text: { content } };
    }

    function rtEq(expression) { return { type: 'equation', equation: { expression } }; }

    function getLatexFromKatex(el) {
      const ann = el.querySelector('annotation[encoding="application/x-tex"]');
      return ann ? ann.textContent : '';
    }

    function pushParagraphRich(rich_text, target = blocks) {
      if (!rich_text || rich_text.length === 0) rich_text = [rtText('')];
      target.push({ object: 'block', type: 'paragraph', paragraph: { rich_text } });
    }

    function parseInline(node, inherited = {}) {
      const out = [];

      function normalizeState(state) {
        return {
          bold: !!state.bold,
          italic: !!state.italic,
          strikethrough: !!state.strikethrough || !!state.strike,
          underline: !!state.underline,
          code: !!state.code,
          link: state.link || null,
          color: state.color || 'default',
        };
      }

      function sameStyle(a, b) {
        return a.bold === b.bold &&
          a.italic === b.italic &&
          a.strikethrough === b.strikethrough &&
          a.underline === b.underline &&
          a.code === b.code &&
          a.color === b.color &&
          a.link === b.link;
      }

      function appendText(txt, state) {
        if (!txt) return;
        const norm = normalizeState(state);
        const last = out[out.length - 1];
        if (last && last.type === 'text') {
          const lastState = {
            bold: !!last.annotations?.bold,
            italic: !!last.annotations?.italic,
            strikethrough: !!last.annotations?.strikethrough,
            underline: !!last.annotations?.underline,
            code: !!last.annotations?.code,
            link: last.text?.link?.url || null,
            color: last.annotations?.color || 'default',
          };
          if (sameStyle(norm, lastState)) {
            last.text.content += txt;
            return;
          }
        }
        const notionAnn = {
          bold: norm.bold,
          italic: norm.italic,
          strikethrough: norm.strikethrough,
          underline: norm.underline,
          code: norm.code,
          color: norm.color,
        };
        out.push(rtText(txt, notionAnn, norm.link));
      }

      function applyStyledAnnotations(el, state) {
        let next = state;
        try {
          const win = el.ownerDocument && el.ownerDocument.defaultView;
          if (win) {
            const cs = win.getComputedStyle(el);
            if (cs) {
              const bold = cs.fontWeight && (!isNaN(Number(cs.fontWeight)) ? Number(cs.fontWeight) >= 600 : /bold/i.test(cs.fontWeight));
              const italic = cs.fontStyle && cs.fontStyle !== 'normal';
              const deco = cs.textDecorationLine || cs.textDecoration || '';
              const underline = /underline/i.test(deco);
              const strike = /line-through/i.test(deco);
              if (bold || italic || underline || strike) next = { ...next };
              if (bold) next.bold = true;
              if (italic) next.italic = true;
              if (underline) next.underline = true;
              if (strike) next.strikethrough = true;
            }
          }
        } catch (e) { /* ignore compute style errors */ }
        return next;
      }

      function walk(n, state = inherited) {
        if (!n) return;
        if (n.nodeType === Node.TEXT_NODE) {
          appendText(n.nodeValue, state);
          return;
        }
        if (n.nodeType !== Node.ELEMENT_NODE) return;
        const el = /** @type {HTMLElement} */(n);

        if (el.matches('span.katex, .katex')) { out.push(rtEq(getLatexFromKatex(el))); return; }

        const tag = el.tagName;
        if (tag === 'BR') { appendText('\n', state); return; }
        if (tag === 'CODE' && el.parentElement && el.parentElement.tagName !== 'PRE') {
          Array.from(el.childNodes).forEach(c => walk(c, { ...state, code: true }));
          return;
        }
        if (tag === 'STRONG' || tag === 'B') {
          Array.from(el.childNodes).forEach(c => walk(c, { ...state, bold: true }));
          return;
        }
        if (tag === 'EM' || tag === 'I') {
          Array.from(el.childNodes).forEach(c => walk(c, { ...state, italic: true }));
          return;
        }
        if (tag === 'S' || tag === 'DEL') {
          Array.from(el.childNodes).forEach(c => walk(c, { ...state, strikethrough: true }));
          return;
        }
        if (tag === 'U' || tag === 'INS') {
          Array.from(el.childNodes).forEach(c => walk(c, { ...state, underline: true }));
          return;
        }
        if (tag === 'MARK') {
          Array.from(el.childNodes).forEach(c => walk(c, { ...state, color: 'yellow_background' }));
          return;
        }
        if (tag === 'A') {
          const href = el.getAttribute('href') || null;
          Array.from(el.childNodes).forEach(c => walk(c, { ...state, link: href }));
          return;
        }

        if (tag === 'UL' || tag === 'OL') {
          return;
        }

        const nextState = applyStyledAnnotations(el, state);
        Array.from(el.childNodes).forEach(c => walk(c, nextState));
      }

      walk(node, inherited);
      return out;
    }

    function pushHeading(level, el, target = blocks) {
      const rich = parseInline(el);
      target.push({ object: 'block', [`type`]: `heading_${level}`, [`heading_${level}`]: { rich_text: rich } });
    }

    function pushCode(el, target = blocks) {
      const info = getCodeInfo(el);
      const markdownTable = parseMarkdownTable(info.text || '');
      if (markdownTable) {
        pushMarkdownTable(markdownTable, target);
        return;
      }
      const lang = mapToNotionLang(info.lang) || 'plain text';
      target.push({ object: 'block', type: 'code', code: { caption: [], rich_text: [rtCodeText(info.text)], language: lang } });
    }

    function pushList(el, ordered = false, target = blocks) {
      const items = Array.from(el.children).filter(li => li.tagName === 'LI');

      function isEmptyRich(rich) {
        if (!rich || !rich.length) return true;
        return rich.every(r => r.type === 'text' && (!r.text?.content || r.text.content.replace(/[\s\u200B-\u200D\uFEFF\u00A0]/g,'') === ''));
      }
      function compactRich(rich) {
        if (!rich) return rich;
        return rich
          .map(r => {
            if (r.type === 'text') {
              const t = (r.text?.content || '').replace(/[\u200B-\u200D\uFEFF]/g,'');
              return { ...r, text: { ...r.text, content: t.replace(/\s+/g, ' ') } };
            }
            return r;
          })
          .filter(r => !(r.type === 'text' && (!r.text?.content || r.text.content.trim() === '')));
      }

      items.forEach(li => {
        const displayKatex = li.querySelector(':scope > .katex-display');
        const onlyDisplay = displayKatex && li.textContent.trim() === displayKatex.textContent.trim();
        const key = ordered ? 'numbered_list_item' : 'bulleted_list_item';
        const payload = () => ({ rich_text: [rtText('')] });
        if (onlyDisplay) {
          const tex = getLatexFromKatex(displayKatex);
          const data = payload();
          data.children = [{ object: 'block', type: 'equation', equation: { expression: tex } }];
          target.push({ object: 'block', type: key, [key]: data });
          return;
        }
        const checkbox = li.querySelector('input[type="checkbox"]');
        let rich = parseInline(li);
        rich = compactRich(rich);
        const childLists = [];
        Array.from(li.children).forEach(child => {
          if (child.tagName === 'UL') pushList(child, false, childLists);
          else if (child.tagName === 'OL') pushList(child, true, childLists);
        });
        if (isEmptyRich(rich) && !childLists.length) return; // 跳过空列表项
        const blockKey = checkbox && checkbox.closest('li') === li ? 'to_do' : key;
        const blockPayloadKey = blockKey === 'to_do' ? 'to_do' : key;
        const blockRich = isEmptyRich(rich) ? [rtText('')] : rich;
        const payloadData = {
          rich_text: blockRich,
          ...(blockKey === 'to_do' ? { checked: !!checkbox?.checked } : {}),
        };
        if (childLists.length) {
          payloadData.children = childLists.map(child => child.object ? child : { ...child, object: 'block' });
        }
        target.push({ object: 'block', type: blockKey, [blockPayloadKey]: payloadData });
      });
    }

    function pushQuote(el, target = blocks) { const rich = parseInline(el); target.push({ object: 'block', type: 'quote', quote: { rich_text: rich } }); }

    function pushTable(el, target = blocks) {
      const rows = tableToRows(el, cell => {
        const rich = parseInline(cell);
        return rich.length ? rich : [];
      });
      if (!rows.cells.length || !rows.width) return;
      const tableRows = rows.cells.map(row => ({
        object: 'block',
        type: 'table_row',
        table_row: { cells: row },
      }));
      target.push({
        object: 'block',
        type: 'table',
        table: {
          table_width: rows.width,
          has_column_header: rows.hasColumnHeader,
          has_row_header: false,
          children: tableRows,
        },
      });
    }

    function pushMarkdownTable(table, target = blocks) {
      const tableRows = table.cells.map(row => ({
        object: 'block',
        type: 'table_row',
        table_row: { cells: row.map(cell => markdownInlineToRichText(cell, rtText)) },
      }));
      target.push({
        object: 'block',
        type: 'table',
        table: {
          table_width: table.width,
          has_column_header: true,
          has_row_header: false,
          children: tableRows,
        },
      });
    }

    function pushParagraphOrEquation(el, target = blocks) {
      const display = el.querySelector(':scope > .katex-display');
      if (display && el.textContent.trim() === display.textContent.trim()) {
        const tex = getLatexFromKatex(display);
        target.push({ object: 'block', type: 'equation', equation: { expression: tex } });
      } else {
        const markdownTable = parseMarkdownTable(getVisibleText(el));
        if (markdownTable) {
          pushMarkdownTable(markdownTable, target);
          return;
        }
        const rich = parseInline(el);
        pushParagraphRich(rich, target);
      }
    }

    function handleBlock(child) {
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      const el = /** @type {HTMLElement} */(child);
      const tag = el.tagName;
      if (/^H[1-3]$/.test(tag)) { pushHeading(parseInt(tag.substring(1), 10), el); return; }
      if (tag === 'P') { pushParagraphOrEquation(el); return; }
      if (isCodeBlockElement(el)) { pushCode(el); return; }
      if (tag === 'UL') { pushList(el, false); return; }
      if (tag === 'OL') { pushList(el, true); return; }
      if (tag === 'BLOCKQUOTE') { pushQuote(el); return; }
      if (tag === 'HR') { blocks.push({ object: 'block', type: 'divider', divider: {} }); return; }
      if (el.classList.contains('katex-display')) { const tex = getLatexFromKatex(el); blocks.push({ object: 'block', type: 'equation', equation: { expression: tex } }); return; }
      if (tag === 'TABLE') { pushTable(el); return; }
      pushParagraphRich(parseInline(el));
    }

    roots.forEach(root => {
      const contentBlocks = collectContentBlocks(root);
      if (contentBlocks.length) contentBlocks.forEach(handleBlock);
      else if (root.innerText && root.innerText.trim()) pushParagraphRich([rtText(root.innerText.trim())]);
    });
    if (blocks.length === 0) pushParagraphRich([rtText(roots.map(root => root.innerText || '').join('\n\n').trim())]);
    return blocks;
  }

  function extractFirstHeadingText(msgNode) {
    const root = getMessageContentRoot(msgNode) || msgNode;
    const hd = (root.querySelector('h1, h2, h3') || {}).textContent;
    if (hd && hd.trim()) return hd.trim().slice(0, 100);
    const p = (root.querySelector('p') || {}).innerText || root.innerText || '';
    return p.trim().slice(0, 60);
  }

  function tableToMarkdown(tableEl) {
    const rows = tableToRows(tableEl, cell => getVisibleText(cell).replace(/\|/g, '\\|').trim());
    if (!rows.cells.length) return '';
    const head = rows.cells[0];
    const sep = head.map(() => '---');
    const body = rows.cells.slice(1);
    const lines = [ `| ${head.join(' | ')} |`, `| ${sep.join(' | ')} |` ];
    body.forEach(r => lines.push(`| ${r.join(' | ')} |`));
    return lines.join('\n');
  }

  function tableToRows(tableEl, cellMapper) {
    const trs = Array.from(tableEl.querySelectorAll('tr'));
    const rawRows = trs.map(tr => Array.from(tr.children).filter(cell => ['TH', 'TD'].includes(cell.tagName)));
    const width = rawRows.reduce((max, row) => Math.max(max, row.length), 0);
    const cells = rawRows
      .filter(row => row.length)
      .map(row => {
        const mapped = row.map(cellMapper);
        while (mapped.length < width) mapped.push(typeof mapped[0] === 'string' ? '' : []);
        return mapped;
      });
    const firstRow = rawRows[0] || [];
    const hasColumnHeader = !!tableEl.querySelector('thead') || firstRow.some(cell => cell.tagName === 'TH');
    return { cells, width, hasColumnHeader };
  }

  function splitMarkdownTableLine(line) {
    let s = String(line || '').trim();
    if (!s.includes('|')) return [];
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    const cells = [];
    let cell = '';
    let escaped = false;
    let backticks = 0;
    for (const ch of s) {
      if (escaped) {
        cell += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '`') {
        backticks = backticks ? 0 : 1;
        cell += ch;
        continue;
      }
      if (ch === '|' && !backticks) {
        cells.push(cell.trim());
        cell = '';
        continue;
      }
      cell += ch;
    }
    cells.push(cell.trim());
    return cells;
  }

  function isMarkdownTableSeparator(line) {
    const cells = splitMarkdownTableLine(line);
    return cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
  }

  function normalizeMarkdownTableRows(rows, width) {
    return rows.map(row => {
      const cells = row.slice(0, width);
      while (cells.length < width) cells.push('');
      return cells;
    });
  }

  function parseMarkdownTable(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
      const header = splitMarkdownTableLine(lines[i]);
      if (header.length < 2 || !isMarkdownTableSeparator(lines[i + 1])) continue;
      const width = header.length;
      const rows = [header];
      for (let j = i + 2; j < lines.length; j++) {
        const row = splitMarkdownTableLine(lines[j]);
        if (row.length < 2) break;
        rows.push(row);
      }
      if (rows.length > 1) return { cells: normalizeMarkdownTableRows(rows, width), width, hasColumnHeader: true };
    }
    return null;
  }

  function markdownTableToMarkdown(table) {
    if (!table || !table.cells?.length) return '';
    const head = table.cells[0].map(cell => String(cell).replace(/\|/g, '\\|'));
    const sep = head.map(() => '---');
    const lines = [`| ${head.join(' | ')} |`, `| ${sep.join(' | ')} |`];
    table.cells.slice(1).forEach(row => lines.push(`| ${row.map(cell => String(cell).replace(/\|/g, '\\|')).join(' | ')} |`));
    return lines.join('\n');
  }

  function markdownInlineToRichText(text, rtText) {
    const out = [];
    const s = String(text || '');
    const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g;
    let lastIndex = 0;
    let match;
    const push = (content, annotations = {}, link = null) => {
      if (content) out.push(rtText(content, annotations, link));
    };
    while ((match = re.exec(s))) {
      push(s.slice(lastIndex, match.index));
      if (match[2]) push(match[2], { bold: true });
      else if (match[3]) push(match[3], { code: true });
      else if (match[4]) push(match[4], {}, match[5]);
      lastIndex = re.lastIndex;
    }
    push(s.slice(lastIndex));
    return out.length ? out : [rtText('')];
  }

  // ===== 观察器：为每条助手消息插入按钮 =====
  function mountObserver() {
    let timer = null;
    const injectAll = () => getAssistantMessageNodes().forEach(ensureBar);
    const scheduleInject = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        injectAll();
      }, 250);
    };
    injectAll();
    const obs = new MutationObserver(() => scheduleInject());
    obs.observe(document.body, { childList: true, subtree: true });
    setInterval(injectAll, 3000);
  }

  (async function init() {
    for (let i = 0; i < 50; i++) {
      if (getAssistantMessageNodes().length) break;
      await sleep(200);
    }
    mountObserver();
    console.log('[ChatGPT → Notion] 已加载');
  })();

})();
 
