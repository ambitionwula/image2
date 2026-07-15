# 造像所 · 本地 AI 图片工作台

一个本地运行的 NewAPI 图片生成与编辑界面，支持：

- 单张图片生成
- 2～10 张图片依次生成（避免并发冲击额度）
- 上传已有图片并通过提示词编辑
- 画笔涂抹局部区域并生成编辑蒙版
- 最多上传 10 张图片，支持主图切换和多图参考编辑
- URL / Base64 两种图片返回格式
- 自定义 NewAPI Base URL、API Key 和模型名
- 接口连接、鉴权及可用模型测试
- 生成结果下载，以及一键送入图片编辑

## 本地启动

需要 Node.js 20 或更高版本。

```bash
npm install
npm run dev
```

浏览器打开 `http://localhost:5173`，点击右上角“接口设置”，填写：

- Base URL：你的 NewAPI 地址，通常以 `/v1` 结尾
- API Key：NewAPI 令牌
- 图片模型：默认为 `image-2`，请以你的 NewAPI 渠道模型名为准

填写后可先点击“测试接口”。测试不会生成图片或消耗生图额度，它会检查 NewAPI 是否可连接、API Key 是否有效，以及当前令牌可见的模型列表。

前端配置只保存在浏览器 localStorage。开发模式下，请同时保持 Vite 页面服务（5173）和本地 API 代理（8787）运行，`npm run dev` 会自动启动二者。

## 生产方式在本机运行

```bash
npm run build
$env:NODE_ENV="production"
npm start
```

然后打开 `http://localhost:8787`。

## Windows / macOS 桌面应用

桌面版会自动启动内置的本地服务，不要求最终用户安装 Node.js。

先安装依赖：

```bash
npm install
```

直接预览桌面应用：

```bash
npm run desktop
```

在 Windows x64 上生成安装版和免安装版：

```bash
npm run pack:win
```

产物位于 `release` 文件夹。

在 macOS 上生成 Intel x64 和 Apple Silicon arm64 的 DMG/ZIP：

```bash
npm run pack:mac
```

macOS 安装包应在 Mac 上构建。项目也包含 `.github/workflows/desktop-build.yml`，推送 `v*` 标签或手动运行 GitHub Actions 后，可下载 Windows 与 macOS 两套构建产物。

未签名的 macOS 应用首次打开时，可能需要在 Finder 中右键应用并选择“打开”。正式公开分发建议配置 Apple Developer ID 签名和公证。
