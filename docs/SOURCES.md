# 网站源适配器

> 文档导航：[WHY / WHAT / HOW / ADR](README.md) · 决策记录：[ADR-0003](adr/0003-source-adapter-registry.md)

## WHY：为什么需要适配层

网站在标题、合集入口和 yt-dlp 元数据上各有差异。如果把域名分支写进 API、合集或下载执行器，每增加一个来源都会扩大修改面。适配层把差异限制在 `src/sources/`，让业务路由和 yt-dlp 执行层保持站点无关。

## WHAT：适配层包含什么

### 目录职责

- `index.js`：`SourceRegistry` 与默认适配器注册顺序。
- `common.js`：URL、HTML 标题、实体解码、标题清洗、集数限制等共享逻辑。
- `generic.js`：所有未知网站的公共兜底，使用 HTML `<title>` 和 yt-dlp 播放列表分析。
- `bilibili.js`：B 站 UGC 合集、传统分 P 和 flat-playlist URL 修补。

`src/ytdlp.js` 只负责启动 yt-dlp、读取 JSON、下载和进度解析；`src/webtitle.js` 是旧调用方的兼容入口，内部也经注册表分派。

### 统一接口

适配器是一个普通对象：

```js
const exampleSource = {
  id: 'example',
  displayName: '示例站',
  matches(url) { return new URL(url).hostname === 'video.example.com'; },

  // 可选：不实现则使用公共 HTML title 解析
  async resolveTitle(url, context) {},

  // 可选：返回 null 表示专用方式不适用，自动回退通用 yt-dlp
  async analyzeCollection(url, context) {},

  // 可选：修补 yt-dlp flat-playlist 中缺失或不完整的单集 URL
  normalizeYtdlpEntry({ itemUrl, entry, root, rawEntries, sourceUrl, index }) {}
};
```

上下文按功能提供 `fetchImpl`、`timeoutMs`、`maxEntries`、`cookiesFromBrowser`、`ytdlp` 和 `fetchCollectionViaYtdlp`。适配器应优先返回标准合集结构：

```js
{
  ok: true,
  title: '合集名',
  entries: [{ title: '第一集', url: 'https://...' }],
  truncated: false
}
```

## HOW：新增一个网站

1. 新建 `src/sources/<site>.js`，只放该站兼容代码。
2. 在 `src/sources/index.js` 导入并加入 `defaultRegistry` 的专用源数组。
3. 在 `test/sources.test.js` 或独立测试文件覆盖 URL 匹配、专用解析和公共回退。

适配器按注册顺序匹配；公共源永远最后执行。因此新增网站不需要修改 API、合集管理、缓存或播放代码。

## ADR：决策与边界

采用注册表、拒绝运行时第三方插件以及公共兜底的原因记录在 [ADR-0003：网站源使用注册表与独立适配器](adr/0003-source-adapter-registry.md)。如果未来要支持外部插件包、沙箱或独立发布周期，应新增 ADR，而不是直接放宽当前加载规则。
