// 本地 / 自托管运行：与 GitHub Actions 工作流完全相同的调度语义（复用 schedule.mjs 与站点脚本）
//
// 用法（建议交给 cron / 计划任务每 30 分钟调用一次，到点才真正登录签到）：
//   node run-local.mjs                  # 两个站点都检查，到了计划时刻的才执行
//   node run-local.mjs checkin.mjs      # 只跑站点一
//   node run-local.mjs checkin2.mjs     # 只跑站点二
//   node run-local.mjs --force          # 忽略计划时刻，立即执行一次（手动测试用）
//
// 账号密码用环境变量提供，也可以写在仓库目录下的 .env.local（KEY=VALUE，每行一个，已在 .gitignore 忽略）：
//   CHECKIN_ACCOUNTS=alice:my-password-1
//   CHECKIN2_ACCOUNTS=foo@example.com:my-password-2
// 其它配置项（*_TIMEZONE、*_WINDOW_START/END、*_LOGIN_STAGGER_*、*_RETRIES 等）与工作流完全一致，见 README。
//
// 状态目录默认是仓库下的 .checkin-state / .checkin2-state（与工作流缓存同名），
// 可用 CHECKIN_STATE_DIR / CHECKIN2_STATE_DIR 覆盖。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const timestamp = () => new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";

const SITES = [
  { script: "checkin.mjs", label: "站点一", accountsVar: "CHECKIN_ACCOUNTS", stateEnv: "CHECKIN_STATE_DIR", defaultStateDir: ".checkin-state", isSecond: false },
  { script: "checkin2.mjs", label: "站点二", accountsVar: "CHECKIN2_ACCOUNTS", stateEnv: "CHECKIN2_STATE_DIR", defaultStateDir: ".checkin2-state", isSecond: true },
];

// .env.local：KEY=VALUE，每行一个，# 开头是注释；不覆盖已存在的环境变量
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function stateDirOf(site) {
  return process.env[site.stateEnv] || path.join(ROOT, site.defaultStateDir);
}

// 与工作流一致：站点二把自己的窗口配置映射成 schedule.mjs 认识的 CHECKIN_* 名称
function scheduleEnv(site) {
  const env = { ...process.env, CHECKIN_STATE_DIR: stateDirOf(site) };
  if (site.isSecond) {
    env.CHECKIN_TIMEZONE = process.env.CHECKIN2_TIMEZONE || "";
    env.CHECKIN_WINDOW_START = process.env.CHECKIN2_WINDOW_START || "";
    env.CHECKIN_WINDOW_END = process.env.CHECKIN2_WINDOW_END || "";
  }
  return env;
}

function spawnNode(args, env, capture) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (capture) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  return result.status ?? 1;
}

function isDue(site) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkin-gate-"));
  const outputFile = path.join(dir, "output");
  fs.writeFileSync(outputFile, "");
  const env = scheduleEnv(site);
  env.GITHUB_OUTPUT = outputFile;
  const status = spawnNode(["schedule.mjs", "due"], env, true);
  const output = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : "";
  fs.rmSync(dir, { recursive: true, force: true });
  if (status !== 0) throw new Error("判断是否到达计划时刻失败（schedule.mjs due 退出码非 0）");
  if (!/^due=(true|false)$/m.test(output)) throw new Error("判断是否到达计划时刻失败（schedule.mjs due 未写出 due 结果）");
  return /^due=true$/m.test(output);
}

function main() {
  loadEnvFile(path.join(ROOT, ".env.local"));

  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const wanted = args.filter((arg) => !arg.startsWith("-"));
  const unknown = wanted.filter((name) => !SITES.some((site) => site.script === name));
  if (unknown.length > 0) {
    console.error(`未知参数：${unknown.join("、")}（只支持 ${SITES.map((site) => site.script).join(" / ")} 与 --force）`);
    return 2;
  }
  const sites = wanted.length > 0 ? SITES.filter((site) => wanted.includes(site.script)) : SITES;

  console.log(`[${timestamp()}] run-local 开始（${sites.map((site) => site.label).join("、")}${force ? "，--force" : ""}）`);
  let failed = 0;
  let executed = 0;
  let skipped = 0;

  for (const site of sites) {
    console.log(`\n[${timestamp()}] ${site.label}（${site.script}）`);
    if (!process.env[site.accountsVar]) {
      console.log(`未配置 ${site.accountsVar}，跳过`);
      skipped += 1;
      continue;
    }
    if (force) {
      console.log("--force：跳过计划时刻检查");
    } else if (!isDue(site)) {
      skipped += 1;
      continue;
    }
    executed += 1;
    const status = spawnNode([site.script], process.env, false);
    const outcome = spawnNode(["schedule.mjs", "update", `--status=${status === 0 ? "success" : "failure"}`], scheduleEnv(site), true);
    if (status !== 0) failed += 1;
    if (outcome !== 0) console.error(`${site.label}：写回运行状态失败（schedule.mjs update 退出码非 0）`);
    console.log(`${site.label} 结果：${status === 0 ? "成功" : "失败"}`);
  }

  console.log(`\n[${timestamp()}] 结束：执行 ${executed} 个站点，跳过 ${skipped} 个，失败 ${failed} 个`);
  return failed > 0 ? 1 : 0;
}

process.exit(main());
