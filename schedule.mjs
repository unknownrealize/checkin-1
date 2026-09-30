// 签到调度状态管理
//
// 工作流每 30 分钟调用一次 `schedule.mjs due`：
//   - 每个「站点自然日」在配置的时间窗口内随机挑一个时刻执行一次，保证每天都有签到
//   - 没有历史状态（首次运行）或已到计划时刻 -> due=true
//   - 否则 -> due=false，本次直接跳过（不会发出任何登录/签到请求）
// 签到执行完后调用 `schedule.mjs update --status=success|failure`：
//   - 成功：计划时刻 = 明天的窗口内随机时刻
//   - 失败：20 分钟后重试，最多尝试 3 次；仍失败则把计划时刻改到下一个还没过的窗口
// 站点本地时区、时间窗口由 CHECKIN_TIMEZONE / CHECKIN_WINDOW_START / CHECKIN_WINDOW_END 配置
// （默认 Asia/Shanghai、08:00~20:00）。状态文件由工作流通过 actions/cache 持久化，不提交进仓库。
import fs from "node:fs";
import path from "node:path";

const STATE_DIR = process.env.CHECKIN_STATE_DIR || ".checkin-state";
const STATE_FILE = path.join(STATE_DIR, "state.json");

const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_WINDOW_START = 8; // 小时，站点本地时间
const DEFAULT_WINDOW_END = 20; // 小时，站点本地时间
const RETRY_SECONDS = 20 * 60; // 失败后的重试间隔
const MAX_FAILS = 3; // 一天内最多连续失败几次（含首次），超过后放弃当天

const timestamp = () => new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";

const TIMEZONE = readTimezone();
const WINDOW = readWindow();

// ---------- 站点本地时间 ----------

const dateTimeFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function zoneTime(epochSeconds) {
  const parts = Object.fromEntries(
    dateTimeFormat
      .formatToParts(epochSeconds * 1000)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    text: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

function zoneOffsetSeconds(epochSeconds) {
  const { day, text } = zoneTime(epochSeconds);
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm, ss] = text.split(" ")[1].split(":").map(Number);
  return Date.UTC(y, m - 1, d, hh, mm, ss) / 1000 - epochSeconds;
}

// 站点本地时间 -> epoch 秒；校正两次，跨夏令时切换也正确
function localToEpoch(y, month, day, secondsOfDay = 0) {
  const base = Date.UTC(y, month - 1, day) / 1000 + secondsOfDay;
  const firstPass = base - zoneOffsetSeconds(base);
  return base - zoneOffsetSeconds(firstPass);
}

const dayKey = (epochSeconds) => zoneTime(epochSeconds).day;

function addDays(day, delta) {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

const formatLocal = (epochSeconds) => `${zoneTime(epochSeconds).text}（${TIMEZONE}）`;

// ---------- 配置 ----------

function readTimezone() {
  const name = (process.env.CHECKIN_TIMEZONE || "").trim() || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: name });
    return name;
  } catch {
    console.error(`环境变量 CHECKIN_TIMEZONE 不是有效时区（${name}），改用默认值 ${DEFAULT_TIMEZONE}`);
    return DEFAULT_TIMEZONE;
  }
}

function readHour(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 24) {
    console.error(`环境变量 ${name} 需要是 0~24 之间的数字，当前值：${raw}，改用默认值 ${fallback}`);
    return fallback;
  }
  return value;
}

function readWindow() {
  const start = readHour("CHECKIN_WINDOW_START", DEFAULT_WINDOW_START);
  const end = readHour("CHECKIN_WINDOW_END", DEFAULT_WINDOW_END);
  if (!(start < end)) {
    console.error(
      `时间窗口无效（CHECKIN_WINDOW_START=${start} 需要小于 CHECKIN_WINDOW_END=${end}），` +
        `改用默认值 ${DEFAULT_WINDOW_START}~${DEFAULT_WINDOW_END}`,
    );
    return { startSeconds: DEFAULT_WINDOW_START * 3600, endSeconds: DEFAULT_WINDOW_END * 3600 };
  }
  return { startSeconds: Math.round(start * 3600), endSeconds: Math.round(end * 3600) };
}

const formatHour = (seconds) =>
  `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}`;

const formatWindow = () => `${formatHour(WINDOW.startSeconds)}~${formatHour(WINDOW.endSeconds)}（${TIMEZONE}）`;

// ---------- 状态 ----------

function readState() {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
  // 旧版本的状态文件只有 nextRunAt，视为没有状态，立即执行一次后重新计时
  if (typeof state?.lastRunAt !== "number" || typeof state?.targetAt !== "number") return null;
  return state;
}

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

// 某一天的窗口内随机时刻
function randomTargetForDay(day) {
  const [y, m, d] = day.split("-").map(Number);
  const start = localToEpoch(y, m, d, WINDOW.startSeconds);
  return start + Math.floor(Math.random() * (WINDOW.endSeconds - WINDOW.startSeconds));
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

// ---------- 子命令 ----------

function cmdDue() {
  const now = Math.floor(Date.now() / 1000);
  const state = readState();

  if (state === null) {
    console.log("没有历史状态（首次运行或缓存已丢失），立即执行一次");
    setOutput("due", true);
    return;
  }

  const due = now >= state.targetAt;
  console.log(`上次执行：${formatLocal(state.lastRunAt)}（${state.lastStatus === "success" ? "成功" : "失败"}）`);
  console.log(`计划时刻：${formatLocal(state.targetAt)} 窗口 ${formatWindow()}`);
  console.log(`当前时间：${formatLocal(now)}`);
  if (state.fails > 0) console.log(`当天已失败 ${state.fails} 次，${due ? "继续重试" : "等待重试时刻"}`);
  console.log(due ? "已到计划时刻，开始执行" : "未到计划时刻，本次跳过");
  setOutput("due", due);
}

function cmdUpdate(status) {
  const isSuccess = status === "success" || status === "ok";
  const now = Math.floor(Date.now() / 1000);
  const state = readState() ?? {};

  let fails = state.fails ?? 0;
  let targetAt;
  let note;

  if (isSuccess) {
    fails = 0;
    targetAt = randomTargetForDay(addDays(dayKey(now), 1));
    note = "今天已完成，计划时刻改到明天的窗口内随机时刻";
  } else {
    fails += 1;
    if (fails < MAX_FAILS) {
      targetAt = now + RETRY_SECONDS;
      note = `本次失败，${RETRY_SECONDS / 60} 分钟后重试（当天第 ${fails + 1} 次尝试）`;
    } else {
      note = `已连续失败 ${fails} 次，放弃当天，改为等明天的窗口`;
      fails = 0;
      targetAt = randomTargetForDay(addDays(dayKey(now), 1));
    }
  }

  writeState({ lastRunAt: now, lastStatus: isSuccess ? "success" : "failure", fails, targetAt });
  console.log(note);
  console.log(
    `状态已更新：status=${isSuccess ? "success" : "failure"} 失败次数=${fails} ` +
      `下次计划=${formatLocal(targetAt)} 窗口 ${formatWindow()}`,
  );
}

const [command, ...args] = process.argv.slice(2);

if (command === "due") {
  cmdDue();
} else if (command === "update") {
  const arg = args.find((item) => item.startsWith("--status="));
  const status = arg?.slice("--status=".length);
  if (!["success", "ok", "failure", "fail"].includes(status)) {
    console.error("用法：node schedule.mjs update --status=success|failure");
    process.exit(1);
  }
  cmdUpdate(status);
} else {
  console.error("用法：node schedule.mjs due | node schedule.mjs update --status=success|failure");
  process.exit(1);
}

console.log(`[${timestamp()}] schedule.mjs ${command} 完成`);
