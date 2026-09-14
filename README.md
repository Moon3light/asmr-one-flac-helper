# ASMR-200 FLAC 助手（Chrome 扩展）

在 [asmr-200.com](https://asmr-200.com)（Kikoeru / ASMR Online）作品页一键下载**根目录的 wav + 配对 vtt 字幕**，在浏览器内流式转换为**内嵌双语歌词、封面和作者标签的 FLAC**，输出到你自己选择的文件夹。

## 功能

1. **白名单激活**：默认仅在 `asmr-200.com/work/*` 作品页生效（可在设置中添加镜像域名）。
2. **下载按钮检查**：执行前先确认页面存在站方“下载”按钮；没有则拒绝执行。
3. **确认清单**：自动预选“最浅音频层”主版本的 wav + 配对 vtt。跨层版本（`附錄音源`、`本篇mp3`、`純人聲wav`、翻译台本等）按深度排除；同层平行版本（如“有音效版 / 無音效版”）自动择优一组，确认页可手动调整。
4. **下载 + 转换**：wav 流式下载 → WASM（libflac）流式编码 FLAC，**原始 wav 全程不落盘**；vtt 转为带时间轴的 LRC 歌词；非中文歌词自动翻译成中文后**双语对照**嵌入。
5. **元数据**：FLAC 内嵌 `LYRICS`（双语歌词）、`TITLE` / `TRACKNUMBER` / `ARTIST`（声优）/ `ALBUM`（作品标题）/ `ORGANIZATION` + `ALBUMARTIST`（社团）/ `DATE` / `GENRE=ASMR` / `COMMENT`（来源链接）、封面 `PICTURE` 块。
6. **输出**：`{你选的文件夹}/{RJ号 标题}/01.flac …`，可选同时导出 `.lrc` 歌词与 `cover.jpg`。
7. **wav 清理**：默认不落盘所以无需清理；勾选“转换后保留原始 wav”则会先写盘、转换成功后自动删除。
8. **数据校验**（v0.1.1 新增）：
   - 下载中途被服务端截断时直接报错，不再静默产出时长缺失的 FLAC；
   - 检测音源数据中途格式突变（站点偶发把 16-bit 数据混入 24-bit 流，编码后会变成整段剧烈噪音），检出即中止并提示重试，不再等用户听出来。

## 安装（开发者模式加载）

1. 打开 Chrome，访问 `chrome://extensions`。
2. 右上角打开“开发者模式”。
3. 点“加载已解压的扩展程序”，选择本目录（`asmr200-flac-helper`）。
4. 建议把扩展图标固定到工具栏。

## 使用

1. 打开任意作品页。
2. 页面右下角会出现蓝色 **FLAC** 浮动按钮（也可点工具栏图标）。
3. 确认清单 → 选择保存文件夹（首次选择后记住，下次不再询问）→ **开始下载并转换**。
4. 进度页可随时取消；全部完成后显示摘要。

## 设置

- **白名单**：默认 `asmr-200.com`。添加其他镜像域名后需点“申请站点权限”。
- **翻译引擎**（默认 **本地 LM Studio**）：
  - `本地 LM Studio / 自定义 LLM`：LM Studio 开启本地服务（默认 `http://localhost:1234/v1`）即可。设置页可一键预设、检测已加载模型、测试翻译。自动剥离 qwen3/deepseek-r1 等思考型模型的 `<think>` 输出，编号行解析失败时自动降级 JSON / 单行重试。Ollama 等其他 OpenAI 兼容服务同样适用。
  - `Google`：免费网页接口，无需配置。网络不可达时歌词保留原文并在日志提示。
  - `微软 Edge`：免费接口（实验性，未在所有网络环境验证）。
- 歌词模式（双语 / 仅中文 / 仅原文 / 不嵌入）、压缩等级、附加文件、保留 wav 均可在每次任务的确认页临时调整，选择会记住。
- 本地模型推荐：`qwen3-8b` 实测日→中歌词翻译质量良好（5 行约 0.6 秒）；`llama-3.2-3b` / `gemma-3n-e4b` 亦可用。

## 技术说明

- 站点公开接口：`/api/workInfo/{id}`、`/api/tracks/{id}?v=2`、`/api/media/download/{hash}`、`/api/cover/{id}.jpg`（均免认证）。`workInfo` 对个别作品不可用时，自动降级为从作品页 DOM 提取标题/社团/声优。
- 本地翻译走 LM Studio 的 OpenAI 兼容接口，manifest 已声明 `http://localhost/*` / `http://127.0.0.1/*` 主机权限（扩展页面可绕过 CORS 直连本地服务）。
- FLAC 编码：[libflac.js](https://github.com/mmig/libflac.js)（WASM），边下载边编码，内存占用低。采样率/位深/声道在流开始时由 WAV 头一次性锁定；data 块大小字段不可信时以站点 API 报告的文件大小为准。
- 元数据注入：纯 JS 实现的 FLAC 容器写入（`STREAMINFO` 补写 PCM MD5 + `VORBIS_COMMENT` + `PICTURE`），不经 C API，测试充分（`test/` 内含端到端验证脚本与产物）。
- 中文判定：假名→日文、谚文→韩文、汉字区分简繁；繁体字幕按需求保留不翻。

## 目录结构

```
asmr200-flac-helper/
├── manifest.json          # MV3 清单
├── background.js          # 默认设置 / 打开任务页 / 白名单站点动态注入
├── content.js             # 作品页注入：下载按钮检测、FLAC 浮动按钮、元数据兜底
├── modules/
│   ├── api.js             # 站点 API 封装（重试、流式下载）
│   ├── select.js          # 预选规则（最浅音频层）
│   ├── vtt.js             # WEBVTT→LRC、语言检测
│   ├── translate.js       # 可插拔翻译（Google/Edge/自定义 LLM）
│   ├── flac.js            # WAV 流式解析 + libflac 编码
│   ├── flacmeta.js        # FLAC 元数据注入（VORBIS_COMMENT/PICTURE/MD5）
│   ├── md5.js             # 流式 MD5
│   └── fsout.js           # 文件夹授权（File System Access API）
├── pages/                 # 任务页 / 弹窗 / 设置页
├── lib/                   # libflac.js WASM 构建
├── icons/                 # 图标（gen_icons.py 生成）
└── test/                  # 端到端测试夹具与产物
```

## 已知限制

- 仅处理**无 DRM 的直链 PCM WAV**（该站点即如此）；位深支持 8/16/24/32bit 整型。
- 本地翻译速度取决于模型；批量 20 行、串行请求，`qwen3-8b` 单批约 0.5-1 秒。首次请求会触发模型加载，请耐心等待。
- 需 Chrome 102+（File System Access API + MV3）。
- 本工具仅自动化浏览器页面上已提供的下载功能并做本地格式整理，请支持原作者（DLsite 购买链接在作品页上）。
