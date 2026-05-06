

# ChatGPT → Notion（保留公式与代码块）— 快速上手 / Quick Start


> Tampermonkey 脚本：一键将 ChatGPT 回答同步到 Notion，保留公式、列表、代码换行和代码块语言。


---


## 中文 · 3 分钟上手
**环境**：Chrome/Edge/Firefox/Safari + Tampermonkey。


**1) 安装脚本**
Tampermonkey → Dashboard → *Create a new script* → 粘贴右侧脚本 → 保存。


**2) 配置 Notion**
- 在 Notion *Settings → Integrations* 新建 **Internal Integration**，复制 **Token**（`secret_...`）。
- 打开目标 **页面/数据库** → **Share → Invite** 该集成（权限 **Can edit**）。
- 回到 ChatGPT 页面，在 Tampermonkey 菜单中打开 **Notion 设置**：
- 粘贴 **Token**；
- 在 **父级 ID** 粘贴 **页面/数据库完整链接**（自动提取 ID，含 `?v=` 也可）；
- 若为数据库，勾选 **父级是数据库**；
- 选择 **每次创建新页面** 或 **追加到页面/块**（*注意：不能填数据库作追加目标*）。


**3) 使用**
在 ChatGPT 助手回答底部：
- **🧭 sendNotion**：推送到 Notion，保留行内/块级公式、列表、表格、代码块换行与语言；
- **📋 copyMarkdown**：复制为 Markdown，保留公式与代码围栏。


**常见问题**
- **400 invalid uuid**：在设置里粘贴**完整链接**；若父级是数据库请**勾选“父级是数据库”**。
- **`$$...$$` 不渲染**：Notion 粘贴限制，优先用“推送到 Notion”，或末尾空格→退格触发。
- **列表出现空圆点**：脚本已规避；如仍出现，删除空行即可。
- **按钮不出现**：刷新 ChatGPT 页面；脚本会适配 `chatgpt.com` 当前消息容器并定时重试注入。
- **代码块变成一行或语言丢失**：更新到最新版脚本。当前版本会从 ChatGPT 代码块读取可见换行和语言标签，并用 Notion 官方 code block 结构写入。


---


## English · Quick Start
**Requirements**: Browser + Tampermonkey.


**1) Add the script**
Tampermonkey → Dashboard → *Create a new script* → paste the code from the canvas → Save.


**2) Notion setup**
- Create an **Internal Integration** (Settings → Integrations), copy the **Token** (`secret_...`).
- Open your target **page or database** → **Share → Invite** the integration (**Can edit**).
- On a ChatGPT page, open **Notion Settings** from the Tampermonkey menu:
- Paste **Token**;
- In **Parent ID**, paste the **full link** of the page/database (ID is auto‑extracted; `?v=` links OK);
- Tick **Parent is a Database** if applicable;
- Choose **Create new page** or **Append to page/block** (*append target must be a page/block, not a database*).


**3) Use**
At the bottom of any assistant answer:
- **🧭 sendNotion** pushes the answer to Notion with math, lists, tables, code line breaks, and code language;
- **📋 copyMarkdown** copies Markdown with math and fenced code blocks.


**Troubleshooting**
- **400 invalid uuid** → Paste the **full link**; tick *Parent is a Database* when needed.
- **`$$...$$` not rendered** → Prefer **Push to Notion**, or type space/backspace after the closing `$`.
- **Blank bullets** → Already mitigated; remove empty lines if any.
- **Buttons do not appear** → Reload ChatGPT. The script now targets current `chatgpt.com` message containers and retries injection.
- **Code blocks lose line breaks or language** → Update to the latest script. It reads visible code text and language labels from ChatGPT and writes Notion code blocks using the official payload shape.
