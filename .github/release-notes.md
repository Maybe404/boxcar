Boxcar 的第一个公开测试版：内核内置的代理 App，打开 App 不会改动任何网络设置，内核只在你点击「启动」时运行。

## 下载

| 系统 | 文件 |
|---|---|
| macOS（Apple 芯片） | `Boxcar-<版本>-macos-arm64.dmg` |
| macOS（Intel） | `Boxcar-<版本>-macos-amd64.dmg` |
| Windows（x64） | `Boxcar-<版本>-windows-amd64-setup.exe` |
| Windows（ARM） | `Boxcar-<版本>-windows-arm64-setup.exe` |

## 请先读

- **这是预发布版本。** Windows 版还没有在 Windows 实机上验证过（验证清单见 #6），可能有问题，欢迎反馈。
- **安装包没有签名。**
  - macOS：第一次打开时系统会阻止。请在「访达」里右键点击 Boxcar →「打开」，或者到「系统设置 → 隐私与安全性」里点「仍要打开」。
  - Windows：SmartScreen 会提示「Windows 已保护你的电脑」，点「更多信息」→「仍要运行」。
- Windows 版暂不包含 NaïveProxy 出站（需要另附 `libcronet.dll`）。
- 需要真实内核验证的功能清单见 #6。

内核：[sing-box](https://github.com/SagerNet/sing-box)（GPL-3.0-or-later）。本项目与 sing-box 及其作者没有关联，也未获得其背书。
