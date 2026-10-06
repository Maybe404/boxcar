# AGENTS.md

给在这个仓库里工作的 AI 编程助手（以及人）的约定。开工前完整读一遍。

## 最重要的原则：不启动内核，不碰系统网络

维护者的电脑上一直运行着另一个代理工具（Surge），网络分流全在它里面配置。内核一旦接管系统网络，就会打乱现有分流，影响正在使用的软件。**这条原则优先于任何任务要求，没有例外。**

### 绝对禁止
- 启动内核：不点 App 里的"启动"，不调用会走到 `boxCore.Start` / `box.Start` / `instance.Start()` 的代码路径，不运行 `sing-box run` 或任何内嵌内核并启动它的程序。
- 任何会改动系统网络的操作：创建虚拟网卡（TUN）、改路由表、改系统代理（`networksetup`、`set_system_proxy`）、改防火墙（pf）、创建系统级 VPN 网卡。
- 运行会监听端口或替系统转发流量的东西。
- 调用 `systemProxy.enable` / `Box.SetSystemProxy(true)`，测试里也不行。
- 安装全局工具（例如往 `~/go/bin` 装东西）；前端依赖只装在 `frontend/node_modules`。

### 可以做
- 读代码、改代码、编译、打包（`./build.sh`、`go build`、`go tool mygo build`）。
- 单元测试：`api_test.go` 里的 `fakeCore` 不会启动内核。新测试一律用假内核。
- 静态检查：`go vet`、`bunx tsc --noEmit`（在 `frontend/` 下）。
- 配置"校验"：`checkConfig` 只执行 `box.New` 后立刻 `Close`，等同 `sing-box check`，已审计过不联网、不监听。
- 浏览器预览界面：`bun run --cwd frontend dev`。在普通浏览器里 `frontend/src/api.ts` 会自动换成合成数据，界面标注"预览数据"。
- 打开 Boxcar.app 只看界面：打开 App 不会启动内核。打开后用 `lsof -nP -i -a -p <pid>` 确认没有网络句柄，用 `scutil --proxy` 确认系统代理没变。

### 需要真实内核的验证
交给维护者手动做。把要验证的点追加到 Issue #6 的清单里，不要自己去跑。

### 产品层面要守住的
- 内核只在用户明确点击"启动"时运行。打开 App、开机自启、订阅自动更新都不会启动它。
- 会接管系统网络的配置启动前必须逐项说明并询问，菜单栏不能启动这类配置（`Box.Takeover`、`StartConfirm`）。
- 系统代理开关开启前保存原设置，关闭、停止、退出、崩溃后重启时都要原样恢复（`sysproxy.go`）。

## 工作方式

- 任务来源是 GitHub Issues，从置顶的 #9（总览）开始，按里面的顺序做。#1 是本原则的 Issue 版本。
- 每项完成后都要跑这几项：
  ```sh
  TAGS=$(tr -d '\n' < "$(go list -m -f '{{.Dir}}' github.com/sagernet/sing-box)/release/DEFAULT_BUILD_TAGS_OTHERS" | tr ',' '\n' | grep -v -e badlinkname -e tfogo | paste -sd, -)
  CGO_ENABLED=0 go vet -tags "$TAGS" . && CGO_ENABLED=0 go test -tags "$TAGS" .
  (cd frontend && bunx tsc --noEmit)
  ```
  然后用浏览器预览检查改到的界面（浅色和深色）。
- 改了 Go 端绑定（`api.go` 里 `Box` 的方法或类型）后，运行 `CGO_ENABLED=0 GOFLAGS="-tags=$TAGS" go tool mygo generate` 重新生成 `frontend/src/mygo.ts`，并同步更新 `frontend/src/api.ts` 里预览用的合成实现。
- 提交信息用英文 conventional commits；界面文字、文档、Issue 用中文。

## 命名与许可证

- sing-box 的 LICENSE 附加条款：衍生作品未经同意，不得使用 sing-box 的名称，也不得暗示与它有关联。
- 所以界面上的标题、状态、按钮统一称"内核"，不写 "sing-box"。只有说明文件格式时可以提（例如"导入 sing-box 配置文件"），署名只放在「关于」页和 README。
- 本项目以 GPL-3.0-or-later 授权。

## 项目结构

- Go（`package main`）：
  - `core.go`：内核的启停、统计、策略组、模式、测速
  - `api.go`：绑定给前端的 `Box` 服务
  - `history.go`：连接记录（同步追踪器）
  - `activity.go`：从日志提取的内核自身活动
  - `sysproxy.go`：可恢复的系统代理
  - `subscription.go`：远程订阅
  - `tray.go`：菜单栏图标
  - `store.go`：配置文件和设置
  - `main.go`：窗口、菜单、退出流程
- 前端：`frontend/`，React + Vite + Radix + cmdk + CodeMirror。设计规范见 `DESIGN.md`，产品说明见 `PRODUCT.md`，界面的设计契约见 `.impeccable/surfaces/`。
