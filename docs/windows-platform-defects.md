# Windows 平台缺陷记录 —— v0.1.6 发布期

> 2026-07-28。这是 RefRain 第一次在 Windows 上真正跑完整测试套件，一夜之间挖出**七类**平台缺陷。
> 记在这里，因为它们有共同的形状：**Unix 不强制的规则，Windows 强制**；在 Linux 上写的代码看不见它们，而 Windows 是 0.1.x 唯一的发布平台。

## 七类缺陷

| # | 症状 | 根因 | 判据 |
|---|---|---|---|
| 1 | 所有状态写入失败 | `fsyncSync` 用只读 fd。Windows 拒绝 flush 一个无写权限的句柄 | 每个 `fsyncSync` 的 fd 必须以 `O_RDWR` 打开（目录除外，目录本就跳过 Windows） |
| 2 | 工作区删不掉，EBUSY | `VerdictLedger` 构造函数在 `openDatabase` 成功后抛错，句柄无人持有。Unix 静默泄漏，Windows 锁住文件 | 构造函数里 open 之后的一切都要 try/catch，失败时 close |
| 3 | 读取 fixture 报 ENOENT `/D:/...` | `URL.pathname` 在 Windows 返回 `/D:/…` | 一律用 `fileURLToPath`；且门禁扫描面必须含 test 目录 |
| 4 | 删 junction 报 EFAULT | `rmSync(path)` 单删目录链接在 Windows 失败 | 用 `rmSync(path, {recursive: true})` |
| 5 | `cannot run sh: not found` | 测试用 `sh` 当假 harness，Windows 无 sh | CI 把 Git 的 `usr/bin` 加进 PATH |
| 6 | **任何 harness 都启动不了** | Windows 环境变量拼作 `Path`，而代码读 `environment.PATH` | 环境变量查找必须大小写不敏感，但精确拼写优先 |
| 7 | 每次启动子进程超时 5 秒 | PATH 变长后每次 launch 都遍历 目录 × 扩展名 | 按「程序名 + PATH」缓存解析结果 |

其中 **2 和 6 是真的产品缺陷**，不是测试问题：作者在 Windows 上会遇到「损坏的账本锁死工作区」与「配置好的 harness 报告未安装」。

## 共同形状

**Unix 宽容的地方，Windows 强制。** 七条里有五条是这个模式：只读 fd 能 flush、泄漏的句柄不锁文件、`rmSync` 能删链接、环境变量区分大小写、PATH 短所以遍历不慢。在 Linux 上这些代码全部正确运行，测试全绿。

**所以「本机全绿」对跨平台项目不构成证据。** 这不是疏忽，是工具的可见性边界——写代码那台机器上，缺陷不存在。

## 已经建立的防线

| 门禁 | 抓什么 | 何时建立 |
|---|---|---|
| `verify:unix-guards` | `std::os::unix` 未加 `cfg(unix)`，会破坏 Windows 编译 | 本轮 |
| `verify:durable-writes` | `fsyncSync` 用只读描述符 | 本轮（缺陷 1 之后） |
| `verify:paths` | `URL.pathname` 当文件路径用；**扫描面已扩到 test 目录** | 扩面在本轮（缺陷 3 之后） |
| Windows 目标 clippy | `#[cfg(windows)]` 分支里的 lint | 本轮，命令见 `AGENTS.md` |

**本机跑 Windows clippy 的方法**（不需要 Windows）：

```bash
rustup target add x86_64-pc-windows-gnu
mkdir -p /tmp/fakenode && touch /tmp/fakenode/libnode.dll
cd packages/fs && LIBNODE_PATH=/tmp/fakenode \
  cargo clippy --target x86_64-pc-windows-gnu --lib --tests
```

空的 `libnode.dll` 满足 napi 构建脚本（它只检查文件存在，而 clippy 走不到链接那步）。

## 还没有防线的部分

这四类目前只能靠 CI 发现：

- **句柄泄漏**（缺陷 2）——已加重复打开 500 次的测试，但那是针对 ledger 一处；构造函数里的资源获取模式没有通用门禁。
- **环境变量大小写**（缺陷 6）——已加针对性测试，但没有门禁能发现「下一处 `env.SOMETHING` 直读」。
- **Windows 专属 API 语义**（缺陷 4）——`rmSync`、`symlinkSync` 的平台差异只能靠真机。
- **性能回归**（缺陷 7）——本机 PATH 短，测不出。

**这四类的共同点是：判据不在源码文本里，而在运行时行为。** 静态门禁看不见，只有真机能答。所以 Windows CI 是这个项目不可替代的一环——不能因为「本机全绿」就跳过它。

## 一条方法教训

**修一类之后必须重跑，不能假设剩下的会一起好。** 本轮七类是分五轮 CI 才挖完的：每修一批，下一批才浮出来（前一批的失败掩盖了后面的）。中途我一度以为「只剩最后一条」，实际还有三类在后面排队。

对应的时间纪律：给估计时说明**这是「若这轮绿」的估计**，而不是「总共还要多久」——因为后者在最后一轮绿之前根本不可知。
