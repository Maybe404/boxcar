# Boxcar

把强大的代理内核装进一个开箱即用的 macOS App：不用另装内核、不用手动启动、不用读懂冗长的配置文件。

Boxcar is a macOS app that brings a capable proxy core to everyday users, with a friendly interface instead of hand-written configuration.

> Boxcar 是独立项目，内核使用 [sing-box](https://github.com/SagerNet/sing-box)（GPL-3.0-or-later）。本项目与 sing-box 及其作者没有关联，也未获得其背书。

## 特点

- **内核内置**：内核作为 Go 库编译进 App，一个 App 就是全部，不需要另装命令行程序或系统扩展。
- **只在你点击时才启动**：打开 App 不会改动任何网络设置；会接管系统网络的配置（TUN、系统代理、改路由等）启动前会逐项说明并询问。
- **流量线路图**：首页把流量走向画成一条线路：本机 → 入站 → 策略组 → 节点 → 互联网，点击站点即可切换节点。
- **一条不漏的连接记录**：每条被路由的连接（含已结束的）都有序号、来源、进程、协议、规则、出站链路、实时速率和解析出的地址，可按客户端或主机分组；DNS、规则集、测速等内核自身的联网单独列出。
- **完整的日志**：内核日志和 App 自身的记录（启停、系统代理、订阅更新、配置的导入和保存）分开筛选；设置里可以按配置的 DNS 规则查询域名。
- **不用写 JSON 的配置**：节点（可粘贴分享链接）、本地代理端口、策略组、分流规则、规则集、DNS 都有向导；其余每个字段都能在「全部字段」里修改，附内核文档的中文说明，和 JSON 编辑器双向同步。
- **配置与订阅**：导入或新建配置、远程订阅定时更新、校验（含启动时才会发现的引用错误）、格式化、运行中重新加载；首次打开时可以从改名前的 SingBox 导入配置。
- **规则 / 全局 / 直连** 模式切换、节点测速、系统代理（关闭时恢复原来的设置）、菜单栏图标、⌘K 命令栏、浅色与深色。

## 构建

需要 Go 1.27 与 Bun。

```sh
cd frontend && bun install && cd ..
./build.sh                    # build/darwin-arm64/Boxcar.app 与安装包
bun run --cwd frontend dev    # 只在浏览器里预览界面（合成数据）
go test -tags "$(tr -d '\n' < "$(go list -m -f '{{.Dir}}' github.com/sagernet/sing-box)/release/DEFAULT_BUILD_TAGS_OTHERS")" .
bun run --cwd frontend test   # 可视化配置的单元测试
go run ./tools/configschema   # 升级内核后：重新生成表单用的 schema 和中文字段说明
```

技术栈：Go + [MyGo](https://mygo.egoist.dev/)（系统 WebView 窗口与类型化绑定）+ React、Radix、cmdk、CodeMirror。界面设计见 [DESIGN.md](DESIGN.md)，产品说明见 [PRODUCT.md](PRODUCT.md)。

## 数据

`~/Library/Application Support/Boxcar`：`profiles/` 是配置文件，`settings.json` 是设置，`work/` 是内核的工作目录（缓存文件等相对路径）。

## 许可证

[GPL-3.0-or-later](LICENSE)。内核 sing-box 以 GPL-3.0-or-later 授权，版权归其作者所有。
