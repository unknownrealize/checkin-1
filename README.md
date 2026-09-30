# 自动签到（GitHub Actions）

基于 GitHub Actions 的多账号自动签到，支持两个站点，各自独立地 **每天在随机时刻执行一次**：

- **站点一**（`checkin.mjs`）：登录 → 随机等待 → 调用签到接口
- **站点二**（`checkin2.mjs`）：登录即签到（站点没有独立的签到接口，登录成功后流程结束）

账号密码保存在仓库 Secret 中；每个账号先 **随机错峰 10~1200 秒** 再登录（站点一登录成功后还会再 **随机等待 10~1200 秒** 才签到）；多个账号 **并发** 执行，互不影响，也不会在同一时刻集中登录。请求遇到 _临时性失败_（网络错误、5xx/429、WAF 风控验证页）会自动重试。只用一个站点也没问题：未配置账号的那个工作流会自动跳过。

## 目录结构

| 文件 | 作用 |
| --- | --- |
| `.github/workflows/checkin.yml` | 站点一的工作流：定时唤醒 + 手动触发 |
| `.github/workflows/checkin2.yml` | 站点二的工作流：定时唤醒 + 手动触发 |
| `checkin.mjs` | 站点一入口：登录 → 随机等待 → 签到接口 |
| `checkin2.mjs` | 站点二入口：登录即签到 |
| `checkin-core.mjs` | 公共逻辑：账号解析、并发控制、随机等待、登录、签到、重试、日志脱敏 |
| `schedule.mjs` | 调度状态：判断是否到达计划时刻、计算下一次计划时刻 |
| `run-local.mjs` | 本地 / 自托管定时运行入口（复用同一套调度逻辑，见「本地 / 自托管运行」） |

## 两个站点的差别

| | 站点一 | 站点二 |
| --- | --- | --- |
| 签到方式 | 登录后调用 `/api/user/checkin` | 登录本身即签到，无额外请求 |
| 登录后随机等待 | 有（10~1200 秒） | 无（没有后续请求可等） |
| 账号 Secret | `CHECKIN_ACCOUNTS` | `CHECKIN2_ACCOUNTS` |
| Variables 前缀 | `CHECKIN_*` | `CHECKIN2_*` |
| 状态缓存目录 | `.checkin-state` | `.checkin2-state` |
| 工作流名称 | 自动签到 | 自动签到 2 |
| 工作流超时 | 90 分钟 | 45 分钟 |

## 执行流程

```mermaid
flowchart TD
    A[工作流每 30 分钟唤醒一次] --> S{账号 Secret 已配置?}
    S -- 否 --> S2[跳过本次，不影响定时计划]
    S -- 是 --> B{当前时间 >= 计划时刻?}
    B -- 否 --> C[跳过本次，不做任何登录/签到请求]
    B -- 是 --> D[所有账号并发执行]
    D --> E[每个账号随机错峰 10~1200 秒]
    E --> F[登录]
    F --> G{站点有独立签到接口?}
    G -- 有 --> H[再随机等待 10~1200 秒]
    H --> I[调用签到接口]
    G -- 无 --> J[登录即完成签到]
    I --> K[记录结果]
    J --> K
    K --> L{本次有账号失败?}
    L -- 否 --> M[计划时刻 = 明天窗口内的随机时刻]
    L -- 是 --> N{当天已失败 3 次?}
    N -- 否 --> O[计划时刻 = 20 分钟后，重试]
    N -- 是 --> P[放弃当天，计划时刻 = 明天窗口内的随机时刻]
```

1. GitHub 的定时任务只能按固定 cron 触发、时刻无法随机，所以工作流每 30 分钟唤醒一次，由 `schedule.mjs due` 读取缓存里的状态判断：没到计划时刻就直接结束，不做任何登录/签到请求（不产生任何流量）。
2. 到计划时刻后脚本并发处理所有账号。每个账号独立执行：先随机错峰等待 **10~1200 秒** → 登录 →（站点一）再随机等待 **10~1200 秒** → 签到；单个账号出错不影响其他账号。临时性失败（网络错误、5xx/429、风控验证页面）会等待 **30~120 秒** 后重试，最多 3 次；密码错误等确定性失败立即结束。
3. 执行完由 `schedule.mjs update` 写回状态：**全部成功** → 计划时刻改为**明天**窗口内的一个随机时刻；**有账号失败** → 20 分钟后重试，当天最多尝试 3 次，仍失败就放弃当天、等明天的窗口。两个站点的状态存在各自独立的缓存中，互不影响。
4. 定时任务每次唤醒都可能被平台延迟几分钟到几十分钟；真实执行时刻是「计划时刻之后的第一次唤醒」，通常晚几分钟。

## 使用步骤

### 1. 把仓库推送到 GitHub

工作流必须在默认分支上，定时任务（schedule）才会生效。仓库名、描述、提交信息建议也不要出现站点字样。

### 2. 配置账号密码 Secret

打开仓库 **Settings → Secrets and variables → Actions → Secrets → New repository secret**，按需配置（两个站点也可以只用一个）：

| Secret 名称 | 用途 |
| --- | --- |
| `CHECKIN_ACCOUNTS` | 站点一的账号，每行一个 |
| `CHECKIN2_ACCOUNTS` | 站点二的账号，每行一个 |

**Secret 内容**：每行一个账号，格式 `用户名:密码`，`#` 开头的行会被忽略（邮箱形式的用户名也可以直接写）：

```text
alice:my-password-1
bob:my-password-2
foo@example.com:my-password-3
```

也支持 JSON 数组格式（属性名必须是 `username` / `password`）：

```json
[
  { "username": "alice", "password": "my-password-1" },
  { "username": "bob", "password": "my-password-2" }
]
```

说明：用户名与密码的分隔符是**第一个冒号或空白字符**，因此密码里可以包含冒号和空格；不支持包含换行的密码。

### 3. 启用 Actions 并手动测试

1. 打开仓库 **Actions** 标签页，如果提示工作流被禁用，点击 **Enable workflow**。
2. 左侧选择「**自动签到**」或「**自动签到 2**」→ 右侧 **Run workflow**。
3. `force` 默认勾选，表示忽略计划时刻立即执行一次（适合验证配置是否正确；这次执行会被记为「今天已经跑过」，计划时刻照常改到明天窗口内）。
4. 展开运行日志，确认每个账号都显示成功；同时看一眼 Actions 页面顶部的运行时长（等待时间最长约 20 分钟属于正常）。

### 4. 完成

之后无需任何操作，两个工作流每天各自在配置的时间窗口内随机挑一个时刻执行一次，运行记录都在 Actions 标签页。

## 本地 / 自托管运行（可选）

不想用 GitHub 托管运行器（出口 IP 容易被 WAF 拦），或者想再留一条本地链路时，可以用 `run-local.mjs` 在自己的机器上跑。它复用同一套调度逻辑和站点脚本，行为与工作流一致：**每 30 分钟检查一次，只有到了当天窗口内的随机时刻才真正登录签到**。

1. 需要 Node.js 18+，把仓库克隆到要运行的机器上。
2. 在仓库目录下新建 `.env.local`（已在 `.gitignore` 中忽略，不会被提交），写入账号：

   ```bash
   CHECKIN_ACCOUNTS=alice:my-password-1
   CHECKIN2_ACCOUNTS=foo@example.com:my-password-2
   ```

   多个账号用 JSON 数组写在一行里（属性名必须是 `username` / `password`），例如 `CHECKIN_ACCOUNTS=[{"username":"alice","password":"p1"},{"username":"bob","password":"p2"}]`；也可以不用文件，直接在命令行里传环境变量（这时可以用真实换行分隔多个账号）。
3. 先手动跑一次确认能签到成功：

   ```bash
   node run-local.mjs --force
   ```
4. 加到系统定时任务，每 30 分钟调用一次。Linux / macOS 的 crontab 示例：

   ```bash
   */30 * * * * cd /path/to/haokun && /usr/bin/node run-local.mjs >> checkin.log 2>&1
   ```

   Windows 用「任务计划程序」：程序填 `node`，参数填 `run-local.mjs`，起始目录填仓库目录，触发器设为每 30 分钟一次。
5. 常用命令：

   | 命令 | 作用 |
   | --- | --- |
   | `node run-local.mjs` | 两个站点都检查，该执行的才执行（推荐交给定时任务） |
   | `node run-local.mjs checkin.mjs` | 只跑站点一 |
   | `node run-local.mjs checkin2.mjs` | 只跑站点二 |
   | `node run-local.mjs --force` | 忽略计划时刻，立即执行一次 |

说明：

- 运行状态保存在仓库下的 `.checkin-state/` 与 `.checkin2-state/`，可以用 `CHECKIN_STATE_DIR` / `CHECKIN2_STATE_DIR` 改到别处；这两个目录都在 `.gitignore` 里。
- 所有配置项（`CHECKIN_WINDOW_START`、`CHECKIN2_TIMEZONE`、`CHECKIN_RETRIES`……）与工作流完全一致，同样通过环境变量或 `.env.local` 提供。
- 和 GitHub Actions 同时开着也不会出错：同一天重复签到只会得到「已签到」，脚本按成功处理；不过建议只保留一条链路，免得白跑。
- 本地链路的出口是自家网络 IP，通常不会被 WAF 拦——被机房 IP 拦死时这是最稳的办法。

## 可选配置（Variables）

在 **Settings → Secrets and variables → Actions → Variables** 中添加，全部可省略。

**站点一（`CHECKIN_*`）**：

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `CHECKIN_TIMEZONE` | `Asia/Shanghai` | 时间窗口使用的时区（IANA 名称，如 `Asia/Tokyo`、`America/New_York`） |
| `CHECKIN_WINDOW_START` | `8` | 每天窗口的起始小时（本地时间，0~24，可写小数如 `8.5`） |
| `CHECKIN_WINDOW_END` | `20` | 每天窗口的结束小时（本地时间，必须大于起始小时） |
| `CHECKIN_BASE_URL` | 内置默认地址 | 站点地址，一般不用改 |
| `CHECKIN_LOGIN_STAGGER_MIN` | `10` | **登录前**随机错峰等待的最小秒数 |
| `CHECKIN_LOGIN_STAGGER_MAX` | `1200` | **登录前**随机错峰等待的最大秒数 |
| `CHECKIN_LOGIN_DELAY_MIN` | `10` | 登录成功后随机等待的最小秒数 |
| `CHECKIN_LOGIN_DELAY_MAX` | `1200` | 登录成功后随机等待的最大秒数 |
| `CHECKIN_CONCURRENCY` | `0` | 并发执行的账号数上限，`0` 表示全部并发 |
| `CHECKIN_RETRIES` | `3` | 每个请求最多尝试次数（含首次），只重试临时性失败 |
| `CHECKIN_RETRY_WAIT_MIN` | `30` | 两次尝试之间随机等待的最小秒数 |
| `CHECKIN_RETRY_WAIT_MAX` | `120` | 两次尝试之间随机等待的最大秒数 |

注意：`CHECKIN_LOGIN_STAGGER_MAX` + `CHECKIN_LOGIN_DELAY_MAX` + 重试等待要小于工作流的 `timeout-minutes`（默认 90 分钟），否则任务会被超时中断。

**站点二（`CHECKIN2_*`）**：

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `CHECKIN2_TIMEZONE` | `Asia/Shanghai` | 时间窗口使用的时区 |
| `CHECKIN2_WINDOW_START` | `8` | 每天窗口的起始小时（本地时间） |
| `CHECKIN2_WINDOW_END` | `20` | 每天窗口的结束小时（本地时间） |
| `CHECKIN2_BASE_URL` | 内置默认地址 | 站点地址，一般不用改 |
| `CHECKIN2_LOGIN_STAGGER_MIN` | `10` | **登录前**随机错峰等待的最小秒数 |
| `CHECKIN2_LOGIN_STAGGER_MAX` | `1200` | **登录前**随机错峰等待的最大秒数 |
| `CHECKIN2_CONCURRENCY` | `0` | 并发执行的账号数上限，`0` 表示全部并发 |
| `CHECKIN2_RETRIES` | `3` | 每个请求最多尝试次数（含首次），只重试临时性失败 |
| `CHECKIN2_RETRY_WAIT_MIN` | `30` | 两次尝试之间随机等待的最小秒数 |
| `CHECKIN2_RETRY_WAIT_MAX` | `120` | 两次尝试之间随机等待的最大秒数 |

站点二没有「登录后等待」配置：登录本身就是签到，没有后续请求可等。

**两个站点通用**：

| 名称 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `RUNNER_LABELS` | Variable | `ubuntu-latest` | 运行器标签，两个工作流共用。设为 `self-hosted` 即改用自托管运行器（出口 IP 是自家网络） |
| `HTTPS_PROXY` | Secret | 空 | 可选代理，如 `http://user:pass@host:port`。配置后签到步骤会走代理，并自动改用 Node 24（只有 Node 24+ 的内置 fetch 会读代理环境变量） |

## 随机性与每天的执行时刻

- **每天一次，时刻随机**：每个「站点自然日」（按 `*_TIMEZONE`）会在 `*_WINDOW_START`~`*_WINDOW_END` 之间随机挑一个时刻执行，默认窗口 08:00~20:00（北京时间）。窗口内的分布是均匀的，所以每天的时刻都不一样。
- **窗口宽度决定两次执行间隔的波动范围**：相邻两天的间隔 = 24 小时 +（两天的随机落点之差），落点都落在宽度为 `W` 的窗口内，因此间隔的理论范围是 **24−W ~ 24+W 小时**。
  - 默认 `W = 12` 小时 → 间隔 12~36 小时，随机性最强。
  - 若想更接近「每天固定间隔」的节奏，把窗口收窄，例如 `WINDOW_START=9`、`WINDOW_END=10`（`W = 1`）→ 间隔 23~25 小时，但每天的签到时刻也稳定在 09:00~10:00。
  - 窗宽的推荐区间是 1~12 小时：太窄会失去随机性，太宽会让两次签到间隔超过一天。
- **为什么不用「固定 24~25 小时」的间隔**：站点按自然日重置签到资格，如果每次都比上次晚一点点（24.5 小时），执行时刻会每天往后漂移，几天后就会跨过午夜、导致某一天无法签到；改成「每天在窗口内随机」后，既随机又保证每个自然日都有一次。
- **夏令时**：窗口按 `*_TIMEZONE` 的本地时间计算，切换夏令时的地区（如 `America/New_York`）在切换当天也仍然按本地时钟执行，不会跑偏或空跑。
- **平台延迟**：GitHub 的定时任务本身可能延迟几分钟到几十分钟（高峰时段更明显），所以实际执行时刻会晚于计划时刻，但不会早于它。
- **手动触发**：勾选 `force` 时忽略计划时刻立即执行一次；这次执行同样会被记为「今天已经跑过」，因此不会在当天再自动跑一次。
- **首次运行 / 缓存被清理**：没有历史状态时会立即执行一次，然后重新开始计时（不会跳过一整天）。

## 常见问题

**Q：日志里会不会泄露密码？**
不会。脚本会先把账号、密码注册为 GitHub 敏感信息（`::add-mask::`），日志中的用户名也做了脱敏（如 `al***ce`）。

**Q：Secret 没配置或配错名字会怎样？**
工作流在「检查账号配置与执行时间」步骤检测不到对应 Secret 时会提示并跳过本次，不会失败、也不占用定时计划；配置好之后自动启用。脚本层面在 CI 中缺少账号变量也会立即报错退出，不会卡住等待输入。

**Q：两个站点只用一个可以吗？**
可以。只配一个 Secret 即可，另一个工作流每次触发都会快速跳过（约几秒），不会产生失败记录。

**Q：状态存在哪里？会写回仓库吗？**
存在 GitHub Actions 的缓存里（站点一 `.checkin-state`，站点二 `.checkin2-state`），**不会往仓库里提交任何东西**。缓存连着 7 天没人用才会被平台清理，而工作流每 30 分钟就会访问一次，正常不会丢；万一丢了，最多就是立刻多执行一次签到后重新计时。

**Q：私有仓库会消耗 Actions 分钟数吗？**
会。每次触发至少按 1 分钟计费，每 30 分钟唤醒一次约等于每天 48 分钟/工作流。公开仓库免费且不限量。

**Q：定时任务突然不跑了？**
公开仓库连续 60 天没有任何仓库活动（提交等）时，GitHub 会自动停用定时任务。到 Actions 页面点击 **Enable workflow** 重新启用即可；保持仓库偶尔有提交可以避免被停用。

**Q：怎么本地测试？**

```bash
# 站点一：登录 -> 随机等待 -> 签到（两个等待都设为 0 可立刻完成）
CHECKIN_ACCOUNTS='alice:my-password' CHECKIN_LOGIN_STAGGER_MIN=0 CHECKIN_LOGIN_STAGGER_MAX=0 CHECKIN_LOGIN_DELAY_MIN=0 CHECKIN_LOGIN_DELAY_MAX=0 node checkin.mjs

# 站点二：登录即签到（只有一个随机等待）
CHECKIN2_ACCOUNTS='foo@example.com:my-password' CHECKIN2_LOGIN_STAGGER_MIN=0 CHECKIN2_LOGIN_STAGGER_MAX=0 node checkin2.mjs

# 交互模式：按提示输入账号密码（站点一 / 站点二）
node checkin.mjs
node checkin2.mjs

# 调度状态机（默认读写 ./.checkin-state，可用 CHECKIN_STATE_DIR 指定目录）
node schedule.mjs due                              # 到计划时刻输出 due=true，否则 due=false
node schedule.mjs update --status=success          # 记录成功：计划时刻改到明天窗口内
node schedule.mjs update --status=failure          # 记录失败：20 分钟后重试，3 次后改为等明天
```

需要 Node.js 18 或更高版本（脚本使用内置的 `fetch`）。想让它按计划每天自动执行（而不是手动跑一次），见上文「本地 / 自托管运行」。

**Q：想改重试次数、重试间隔？**
改 `schedule.mjs` 顶部的常量：`RETRY_SECONDS`（失败后的重试间隔，默认 20 分钟）、`MAX_FAILS`（当天最多尝试几次，默认 3），两个站点同时生效；「每天几点到几点执行」不用改代码，通过 Variables 里的 `*_WINDOW_START` / `*_WINDOW_END` / `*_TIMEZONE` 调整。

**Q：想换签到站点？**
不用改代码：站点一配置 `CHECKIN_BASE_URL`，站点二配置 `CHECKIN2_BASE_URL`，即可覆盖内置默认地址。

**Q：站点返回「今天已经签到过了」会算失败吗？**
不会。这种响应（`success=false` 且消息含「已签到 / 已签到过 / 重复签到 / already checked」等）会被记为「已签到」，与成功一样结束当天流程，不会触发 20 分钟后的重试，也不会让工作流变红；只有真正的失败（HTTP 错误、网络错误、风控页面、令牌无效等）才会重试。

**Q：日志出现「被站点风控拦截：返回的是 HTML 验证页面」怎么办？**
这说明请求被站点前面的 WAF 拦下了：它返回 HTTP 200 + 一个 HTML 验证页而不是 JSON，跟账号密码无关（同一条请求在你本机、用同样的请求头是能拿到 JSON 的）。新版日志会把页面线索一起打出来，例如：

```text
被站点风控拦截：返回的是 HTML 验证页面（HTTP 200，疑似阿里云 WAF 验证页，标题「验证」，
内容开头「请开启 JavaScript 抱歉，当前访问被拦截，请稍后再试」），常见原因是出口 IP 被临时拦截或限流（例如 GitHub 托管运行器）
```

看到「疑似阿里云 WAF 验证页」基本可以确定是出口 IP 信誉问题：GitHub 托管运行器用的是云机房 IP，同一段 IP 上还有大量其他用户的自动化请求，很容易被 WAF 直接判为可疑流量；页面里的 JS 校验脚本（`acw_sc__v2`）需要浏览器执行，脚本没法过。

脚本已经做过的处理：这类失败按临时性失败对待，等待 `*_RETRY_WAIT_MIN`~`*_RETRY_WAIT_MAX`（默认 30~120 秒）后重试，最多 `*_RETRIES` 次（默认 3 次）；当天仍失败就 20 分钟后整体再来一轮，最多 3 轮。多数临时限流会在这几轮里恢复。

先明确一点：**没有脚本层的「绕过」**。验证页里的 JS 校验（`acw_sc__v2`）需要浏览器执行，纯脚本过不了；能不能通过只看**出口 IP 的信誉**。可行的办法只有换出口：

| 方案 | 做法 | 说明 |
| --- | --- | --- |
| ① 自托管运行器 | 在自家机器/服务器上装 GitHub Actions runner，再把仓库 Variable `RUNNER_LABELS` 设为 `self-hosted` | 出口变成自家网络 IP；工作流、日志、定时都不用改，两个工作流同时生效 |
| ② 代理出口 | 在 Secrets 里配置 `HTTPS_PROXY`（如 `http://user:pass@host:port`） | 工作流已内置：签到步骤带 `NODE_USE_ENV_PROXY=1`，检测到该 Secret 时自动安装 Node 24（只有 Node 24+ 的内置 `fetch` 才读代理环境变量，已验证生效）。代理 IP 必须干净——数据中心 IP、公开免费代理往往自己就在黑名单里，住宅 IP 最稳 |
| ③ 本地运行 | 在自家机器上用 `node run-local.mjs` + 系统定时任务 | 见上文「本地 / 自托管运行」，出口同样是自家 IP |

调大 `*_LOGIN_STAGGER_MIN/MAX`、`*_RETRY_WAIT_MIN/MAX` 只能降低触发概率，解决不了整段 IP 被拦的情况。

**Q：日志里怎么区分「密码错误」和「风控拦截」？**
密码错误是 HTTP 401/200 + JSON，消息形如 `登录失败，HTTP 401：{"success":false,...}`；风控拦截是 HTTP 200 + HTML 页面，消息里会明确写「被站点风控拦截」，并且只截取前 200 个字符，不会刷屏。

**Q：某个账号密码填错了会怎样？**
该账号会失败，其他账号不受影响；工作流整体标记为失败，20 分钟后重试，当天最多尝试 3 次，随后等下一个窗口。修正 Secret 后立即生效。

## 安全提示

- 账号密码只放在 Secret 里，不要写进代码、Issue 或提交历史。
- Secret 不会传递给来自 fork 的 Pull Request，也不会以明文出现在日志中。
- 自动化签到可能违反站点的服务条款，请自行评估风险。
