# CLI 命令重构说明

## 概述

本次重构完全重新设计了 `send` 和 `receive` 命令，以统一命令行参数、简化代码结构、提高可维护性。

## 最新更新（2025-12-05）

### 🎯 核心改进

1. **保持服务器运行**：选择设备连接后不再停止 HTTP 服务器和 mDNS 广播
   - 支持 `--limit` 参数设置多次传输
   - 完成一次传输后自动继续等待下一个连接
   - 允许同时通过 HTTP 和 mDNS 方式接收/发送多个文件

2. **简化输出信息**：减少冗余输出，提升用户体验
   - 移除重复的状态消息
   - 详细信息仅在 `--debug` 模式下显示
   - 紧凑的进度和状态提示

3. **二维码支持**：自动生成并显示服务器地址二维码
   - 方便移动设备快速连接
   - 支持 HTTP 直接访问
   - 仅显示主要 IP 地址的二维码

### 📱 二维码功能

启动服务器后会自动显示二维码：
```
✓ Server ready
📍 http://192.168.1.100:40000
🔐 Code: 123456

Scan QR code to connect:
█████████████████████████████
█████████████████████████████
```

### 🔄 多次传输支持

使用 `--limit` 参数控制传输次数：

```bash
# 发送文件，允许 5 次下载
howl send file.pdf --limit 5

# 接收文件，允许 3 次上传
howl receive --limit 3

# 无限制传输（直到手动停止）
howl send file.pdf --limit 0
howl receive --limit 0
```

### 💬 简化的输出示例

**发送端（send）**：
```
✓ Server ready and broadcasting
📍 http://192.168.1.100:40000
🔐 Code: 123456

[QR Code]

Limit: 3 downloads

📥 192.168.1.101
✓ Verified: 192.168.1.101
🚀 Sending to 192.168.1.101...
Transfer |███████████████████████| 100% | 10/10 MB | Speed: 5.2 MB/s | ETA: 0s
✓ Sent to 192.168.1.101 (10.5 MB)
```

**接收端（receive）**：
```
✓ Server ready and broadcasting
📍 http://192.168.1.100:40001

[QR Code]

Limit: unlimited uploads

✓ Received: document.pdf (2.3 MB)
✓ Received: image.jpg (1.5 MB)
```

### 🐛 调试模式

使用 `--debug` 显示详细信息：
```bash
howl send file.pdf --debug
howl receive --debug
```

调试模式会显示：
- 详细的服务器配置信息
- 所有本地 IP 地址
- 连接指令说明
- 防火墙配置详情
- 内部状态变化

## 新增工具模块

### 1. `device-discovery-service.ts`
统一处理设备发现逻辑，包括：
- 自动发现附近设备
- 设备选择菜单
- 重新搜索功能
- 支持发送端和接收端两种模式

### 2. `http-server-manager.ts`
统一处理 HTTP 服务器管理：
- 查找可用端口
- Windows 防火墙配置
- 启动/停止服务器
- 支持发送端和接收端服务器

### 3. `transfer-handler.ts`
统一处理文件传输：
- 文件上传进度显示
- 文件下载进度显示
- 验证码输入提示
- 错误处理

## 统一的命令行参数

### 共有参数（send 和 receive 都支持）

- `--mode lan|wan` - 传输模式（默认: lan）
- `--name <名称>` - 设备显示名称（默认: 主机名）
- `--limit <数字>` - 上传/下载次数限制（默认: 1，0 表示无限制）
- `--no-verification` - 禁用验证码（默认: 启用）
- `--debug` - 启用调试日志
- `--skip-firewall` - 跳过 Windows 防火墙配置
- `--port <数字>` - 指定 HTTP 端口（默认: 自动选择）
- `--disable-lan` - 禁用 mDNS 发现功能

### receive 独有参数

- `-o, --output <目录>` - 接收文件的保存目录（默认: ./downloads）

## 工作流程

### 默认模式（HTTP + mDNS）

1. **启动 HTTP 服务器**
   - 查找可用端口
   - 配置防火墙（Windows）
   - 启动服务器

2. **启动 mDNS 广播和发现**
   - 广播当前设备信息
   - 持续监听附近设备

3. **设备发现**
   - 持续搜索直到发现至少一个设备
   - 发现首个设备后 3 秒自动显示设备列表
   - 用户可选择设备或按 R 重新搜索
   - 如果按 Ctrl+C 取消选择，继续以服务器模式运行

4. **连接和传输**
   - 如果用户选择了设备：
     - 停止当前服务器
     - 提示输入验证码
     - 建立连接并传输文件
   - 如果用户取消选择：
     - 继续以服务器模式运行
     - 等待其他设备连接

### 仅服务器模式（--disable-lan）

1. 启动 HTTP 服务器
2. 显示连接信息
3. 等待其他设备连接

## 设备搜索逻辑

### 首次搜索
- 持续搜索直到找到至少一个设备
- 找到首个设备后等待 3 秒
- 3 秒后显示所有已发现的设备列表

### 重新搜索（按 R 键）
- 清空已有设备列表
- 如果当前已有设备：搜索 5 秒后显示结果
- 如果当前无设备：持续搜索直到找到至少一个设备

## 代码结构改进

### 之前
- `send.ts`: ~650 行，包含所有逻辑
- `receive.ts`: ~900 行，包含所有逻辑
- 大量重复代码
- 难以维护和测试

### 之后
- `send.ts`: ~380 行，主要是业务逻辑
- `receive.ts`: ~280 行，主要是业务逻辑
- `device-discovery-service.ts`: ~280 行，统一设备发现
- `http-server-manager.ts`: ~145 行，统一服务器管理
- `transfer-handler.ts`: ~180 行，统一传输处理
- 代码复用度高
- 易于维护和测试

## 示例命令

```bash
# 发送文件（默认模式）
howl send ./file.pdf

# 发送文件，限制 3 次下载
howl send ./file.pdf --limit 3

# 发送文件，禁用验证码
howl send ./file.pdf --no-verification

# 发送文件，仅服务器模式（不启用 mDNS）
howl send ./file.pdf --disable-lan

# 接收文件（默认模式）
howl receive

# 接收文件到指定目录
howl receive --output ~/Downloads

# 接收文件，允许无限制上传
howl receive --limit 0

# 接收文件，指定端口
howl receive --port 8080
```

## 兼容性说明

- 旧的命令行参数已更新为新的参数名
- `--downloads` → `--limit` (send)
- `--uploads` → `--limit` (receive)
- `--dev` → `--debug`
- `--lan-only` (receive) → `--mode lan` (通用)
- 新增 `--disable-lan` 用于禁用 mDNS
- 新增 `--name` 用于自定义设备名称

## 旧文件备份

- `receive.old.ts` - 原始的 receive 命令
- `send.old.ts` - 原始的 send 命令

这些文件已被保留以供参考，可以在确认新版本运行正常后删除。
