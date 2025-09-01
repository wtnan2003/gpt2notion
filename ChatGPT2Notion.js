// ==UserScript==
// @name         ChatGPT → Notion（保留公式｜数据库支持｜修复列表与代码语言｜按钮置底不显设置）
// @namespace    https://github.com/wtnan2003/gpt2notion
// @version      1.2.0
// @description  将 ChatGPT 回答复制/推送到 Notion，并保留 LaTeX；支持父级为 Page/Database；自动修正代码语言别名；避免列表空圆点；按钮位于回答底部且隐藏设置按钮（通过 Tampermonkey 菜单打开设置）。
// @author       you
// @match        https://chat.openai.com/*
// @match        https://chatgpt.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      api.notion.com
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

  async function createPageWithBlocks(title, children) {
    const cfg = getConfig();
    if (!cfg.token) throw new Error('未配置 Notion Token');

    const parentId = normalizeNotionId(cfg.parentIdRaw);
    const appendId = normalizeNotionId(cfg.appendTargetIdRaw);

    if (!parentId && !appendId) throw new Error('未配置 Notion 目标：请填写父页面/数据库 ID，或要追加的页面/块 ID');

    if (cfg.preferCreateNewPage) {
      if (!parentId) throw new Error('未配置父级 ID（页面或数据库）');
      const parent = cfg.parentIsDatabase ? { database_id: parentId } : { page_id: parentId };
      const payload = {
        parent,
        properties: cfg.parentIsDatabase
          ? undefined
          : { title: { title: [{ type: 'text', text: { content: title } }] } },
        children,
      };
      const page = await notionRequest({ method: 'POST', url: '/pages', data: payload });
      return page;
    } else {
      if (!appendId) throw new Error('未配置“追加到页面/块 ID”');
      const res = await notionRequest({ method: 'PATCH', url: `/blocks/${appendId}/children`, data: { children } }).catch(e => {
        if (/database/i.test(String(e))) throw new Error('“追加到”目标看起来像数据库 ID。请改用“创建新页面”并将父级设置为该数据库。');
        throw e;
      });
      return res;
    }
  }

  // ===== DOM 选择器适配 =====
  function getAssistantMessageNodes() {
    const candidates = [
      'div[data-message-author-role="assistant"]',
      'article:has(.markdown)',
      '.markdown:not(article .markdown)'
    ];
    const set = new Set();
    candidates.forEach(sel => document.querySelectorAll(sel).forEach(n => set.add(n.closest('div, article') || n)));
    return Array.from(set).filter(Boolean);
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

    // 插入位置：回答的最底端
    const target = msgNode.querySelector('.markdown')?.parentElement || msgNode;
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
    const root = msgNode.querySelector('.markdown') || msgNode;

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
      if (tag === 'PRE') {
        const code = el.querySelector('code');
        const lang = Array.from(code?.classList || []).find(c => c.startsWith('language-'))?.replace('language-', '') || '';
        const txt = code ? code.textContent : el.textContent;
        mdLines.push('```' + (lang || ''));
        mdLines.push((txt || '').replace(/\n$/, ''));
        mdLines.push('```');
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
      mdLines.push(textFromNode(el));
      mdLines.push('');
    }

    Array.from(root.children).forEach(handleBlock);
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
    const root = msgNode.querySelector('.markdown') || msgNode;
    const blocks = [];

    function rtText(content, annotations = {}, link = null) {
      return { type: 'text', text: { content, link: link ? { url: link } : null }, annotations: {
        bold: !!annotations.bold,
        italic: !!annotations.italic,
        strikethrough: !!annotations.strike,
        underline: !!annotations.underline,
        code: !!annotations.code,
        color: 'default'
      } };
    }

    function rtEq(expression) { return { type: 'equation', equation: { expression } }; }

    function getLatexFromKatex(el) {
      const ann = el.querySelector('annotation[encoding="application/x-tex"]');
      return ann ? ann.textContent : '';
    }

    function pushParagraphRich(rich_text) {
      if (!rich_text || rich_text.length === 0) rich_text = [rtText('')];
      blocks.push({ type: 'paragraph', paragraph: { rich_text } });
    }

    function parseInline(node, inherited = {}) {
      const out = [];
      function appendText(txt, ann = {}, link = null) {
        if (!txt) return;
        const last = out[out.length - 1];
        if (last && last.type === 'text') {
          const same = (a,b) => JSON.stringify(a)===JSON.stringify(b);
          const cur = { bold:!!(inherited.bold||ann.bold), italic:!!(inherited.italic||ann.italic), strikethrough:!!(inherited.strike||ann.strike), underline:!!(inherited.underline||ann.underline), code:!!(inherited.code||ann.code), link:link||null };
          const lst = { bold:!!last.annotations?.bold, italic:!!last.annotations?.italic, strikethrough:!!last.annotations?.strikethrough, underline:!!last.annotations?.underline, code:!!last.annotations?.code, link:last.text?.link?.url||null };
          if (same(cur,lst)) { last.text.content += txt; return; }
        }
        out.push(rtText(txt, { ...inherited, ...ann }, link));
      }

      function walk(n, inh = inherited) {
        if (n.nodeType === Node.TEXT_NODE) { appendText(n.nodeValue); return; }
        if (n.nodeType !== Node.ELEMENT_NODE) return;
        const el = /** @type {HTMLElement} */(n);

        if (el.matches('span.katex, .katex')) { out.push(rtEq(getLatexFromKatex(el))); return; }
        const tag = el.tagName;
        if (tag === 'BR') { appendText('\n'); return; }
        if (tag === 'CODE' && el.parentElement && el.parentElement.tagName !== 'PRE') { Array.from(el.childNodes).forEach(c => walk(c, { ...inh, code: true })); return; }
        if (tag === 'STRONG' || tag === 'B') { Array.from(el.childNodes).forEach(c => walk(c, { ...inh, bold: true })); return; }
        if (tag === 'EM' || tag === 'I') { Array.from(el.childNodes).forEach(c => walk(c, { ...inh, italic: true })); return; }
        if (tag === 'S' || tag === 'DEL') { Array.from(el.childNodes).forEach(c => walk(c, { ...inh, strike: true })); return; }
        if (tag === 'U') { Array.from(el.childNodes).forEach(c => walk(c, { ...inh, underline: true })); return; }
        if (tag === 'A') {
          const href = el.getAttribute('href');
          Array.from(el.childNodes).forEach(c => {
            if (c.nodeType === Node.TEXT_NODE) appendText(c.nodeValue, {}, href);
            else walk(c, inh);
          });
          return;
        }
        Array.from(el.childNodes).forEach(c => walk(c, inh));
      }

      walk(node, inherited);
      return out;
    }

    function pushHeading(level, el) {
      const rich = parseInline(el);
      blocks.push({ [`type`]: `heading_${level}`, [`heading_${level}`]: { rich_text: rich } });
    }

    function pushCode(el) {
      const code = el.querySelector('code');
      let lang = '';
      if (code) {
        const cls = Array.from(code.classList || []);
        const fromClass = cls.find(c => c.startsWith('language-'))?.replace('language-', '');
        const dataLang = code.getAttribute('data-language') || el.getAttribute('data-language');
        lang = fromClass || dataLang || '';
      }
      lang = mapToNotionLang(lang) || 'plain text';

      const txt = code ? code.textContent : el.textContent;
      blocks.push({ type: 'code', code: { language: lang, rich_text: [rtText(txt)] } });
    }

    function pushList(el, ordered = false) {
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
        if (onlyDisplay) {
          const tex = getLatexFromKatex(displayKatex);
          blocks.push({
            type: key,
            [key]: { rich_text: [rtText('')] },
            children: [{ type: 'equation', equation: { expression: tex } }]
          });
          return;
        }
        let rich = parseInline(li);
        rich = compactRich(rich);
        if (isEmptyRich(rich)) return; // 跳过空列表项
        blocks.push({ type: key, [key]: { rich_text: rich } });
      });
    }

    function pushQuote(el) { const rich = parseInline(el); blocks.push({ type: 'quote', quote: { rich_text: rich } }); }

    function pushParagraphOrEquation(el) {
      const display = el.querySelector(':scope > .katex-display');
      if (display && el.textContent.trim() === display.textContent.trim()) {
        const tex = getLatexFromKatex(display);
        blocks.push({ type: 'equation', equation: { expression: tex } });
      } else {
        const rich = parseInline(el);
        pushParagraphRich(rich);
      }
    }

    function handleBlock(child) {
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      const el = /** @type {HTMLElement} */(child);
      const tag = el.tagName;
      if (/^H[1-3]$/.test(tag)) { pushHeading(parseInt(tag.substring(1), 10), el); return; }
      if (tag === 'P') { pushParagraphOrEquation(el); return; }
      if (tag === 'PRE') { pushCode(el); return; }
      if (tag === 'UL') { pushList(el, false); return; }
      if (tag === 'OL') { pushList(el, true); return; }
      if (tag === 'BLOCKQUOTE') { pushQuote(el); return; }
      if (tag === 'HR') { blocks.push({ type: 'divider', divider: {} }); return; }
      if (el.classList.contains('katex-display')) { const tex = getLatexFromKatex(el); blocks.push({ type: 'equation', equation: { expression: tex } }); return; }
      if (tag === 'TABLE') { const md = tableToMarkdown(el); blocks.push({ type: 'code', code: { language: 'markdown', rich_text: [rtText(md)] } }); return; }
      pushParagraphRich(parseInline(el));
    }

    const container = root;
    Array.from(container.children).forEach(handleBlock);
    if (blocks.length === 0) pushParagraphRich([rtText(root.innerText || '')]);
    return blocks;
  }

  function extractFirstHeadingText(msgNode) {
    const hd = (msgNode.querySelector('.markdown h1, .markdown h2, .markdown h3') || {}).textContent;
    if (hd && hd.trim()) return hd.trim().slice(0, 100);
    const p = (msgNode.querySelector('.markdown p') || {}).innerText || '';
    return p.trim().slice(0, 60);
  }

  function tableToMarkdown(tableEl) {
    function rowToArr(tr) { return Array.from(tr.children).map(td => td.innerText.replace(/\|/g, '\\|').trim()); }
    const rows = Array.from(tableEl.querySelectorAll('tr')).map(rowToArr);
    if (!rows.length) return '';
    const head = rows[0];
    const sep = head.map(() => '---');
    const body = rows.slice(1);
    const lines = [ `| ${head.join(' | ')} |`, `| ${sep.join(' | ')} |` ];
    body.forEach(r => lines.push(`| ${r.join(' | ')} |`));
    return lines.join('\n');
  }

  // ===== 观察器：为每条助手消息插入按钮 =====
  function mountObserver() {
    const injectAll = () => getAssistantMessageNodes().forEach(ensureBar);
    injectAll();
    const obs = new MutationObserver(() => injectAll());
    obs.observe(document.body, { childList: true, subtree: true });
  }

  (async function init() {
    GM_registerMenuCommand('Notion 设置', openConfigPanel);
    for (let i = 0; i < 50; i++) {
      if (getAssistantMessageNodes().length) break;
      await sleep(200);
    }
    mountObserver();
    console.log('[ChatGPT → Notion] 已加载');
  })();

})();
