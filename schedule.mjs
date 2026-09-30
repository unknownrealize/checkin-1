// 签到调度状态管理
//
// 工作流每 30 分钟调用一次 `schedule.mjs due`：
//   - 没有历史状态（首次运行）或已到时间 -> due=true
//   - 否则 -> due=false，本次直接跳过
// 签到执行完后调用 `schedule.mjs update --status=success|failure`：
//   - 成功：下次执行时间 = 现在 + 24 小时 + 随机 0~3600 秒
//   - 失败：间隔 20 分钟后重试，最多重试 3 次，之后回到 24~25 小时的正常节奏
// 状态文件由工作流通过 actions/cache 持久化，不会提交进仓库。
import fs from "node:fs";
import path from "node:path";

const STATE_DIR = process.env.CHECKIN_STATE_DIR || ".checkin-state";
const STATE_FILE = path.join(STATE_DIR, "state.json");

const DAY_SECONDS = 24 * 60 * 60;
const MAX_EXTRA_SECONDS = 60 * 60; // 额外随机 0~1 小时，即两次执行间隔 24~25 小时
const RETRY_SECONDS = 20 * 60; // 失败后的重试间隔
const MAX_FAILS = 3; // 一个周期内最多连续失败几次（含首次），超过后等下一个周期

const timestamp = () => new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
const formatTime = (epochSeconds) => new Date(epochSeconds * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z";

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function nextRunTime(now) {
  return now + DAY_SECONDS + Math.floor(Math.random() * (MAX_EXTRA_SECONDS + 1));
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

function cmdDue() {
  const now = Math.floor(Date.now() / 1000);
  const state = readState();

  let due;
  if (state === null) {
    console.log("没有历史状态（首次运行或缓存已丢失），立即执行");
    due = true;
  } else {
    console.log(
      `上次执行：${formatTime(state.lastRunAt)}（${state.lastStatus === "success" ? "成功" : "失败"}），` +
        `计划时间：${formatTime(state.nextRunAt)}，当前时间：${formatTime(now)}`,
    );
    due = now >= state.nextRunAt;
  }

  console.log(due ? "已到执行时间" : "未到执行时间，本次跳过");
  setOutput("due", due);
}

function cmdUpdate(status) {
  const isSuccess = status === "success" || status === "ok";
  const now = Math.floor(Date.now() / 1000);
  const state = readState() ?? {};

  let fails = state.fails ?? 0;
  let nextRunAt;

  if (isSuccess) {
    fails = 0;
    nextRunAt = nextRunTime(now);
  } else {
    fails += 1;
    if (fails < MAX_FAILS) {
      nextRunAt = now + RETRY_SECONDS;
    } else {
      console.log(`已连续失败 ${fails} 次，本周期不再重试`);
      fails = 0;
      nextRunAt = nextRunTime(now);
    }
  }

  writeState({ lastRunAt: now, lastStatus: isSuccess ? "success" : "failure", fails, nextRunAt });
  console.log(`状态已更新：status=${isSuccess ? "success" : "failure"} 失败次数=${fails} 下次执行=${formatTime(nextRunAt)}`);
}

const [command, ...args] = process.argv.slice(2);

if (command === "due") {
  cmdDue();
} else if (command === "update") {
  const arg = args.find((item) => item.startsWith("--status="));
  if (!arg) {
    console.error("用法：node schedule.mjs update --status=success|failure");
    process.exitCode = 1;
  } else {
    cmdUpdate(arg.slice("--status=".length));
  }
} else {
  console.error("用法：node schedule.mjs due | node schedule.mjs update --status=success|failure");
  process.exitCode = 1;
}

console.log(`[${timestamp()}] schedule.mjs ${command ?? ""} 完成`);
