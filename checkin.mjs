// 自动签到脚本（GitHub Actions / 本地运行）
//
// 批量模式：CHECKIN_ACCOUNTS='账号1:密码1\n账号2:密码2' node checkin.mjs
// 交互模式：node checkin.mjs
//
// 每个账号的流程：登录 -> 随机等待 CHECKIN_LOGIN_DELAY_MIN~MAX 秒 -> 签到
// 多个账号默认并发执行（可用 CHECKIN_CONCURRENCY 限制并发数）。
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// 内置默认站点地址（Base64 编码，运行时解码；可用 CHECKIN_BASE_URL 环境变量覆盖）
const DEFAULT_BASE_URL = Buffer.from("aHR0cHM6Ly9hcGkuaGFva3VuLmRl", "base64").toString("utf8");
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timestamp = () => new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
const log = (message) => console.log(`[${timestamp()}] ${message}`);

function readIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`环境变量 ${name} 需要是非负整数，当前值：${raw}`);
  }
  return value;
}

function readConfig() {
  let delayMin = readIntEnv("CHECKIN_LOGIN_DELAY_MIN", 10);
  let delayMax = readIntEnv("CHECKIN_LOGIN_DELAY_MAX", 1200);
  if (delayMin > delayMax) [delayMin, delayMax] = [delayMax, delayMin];
  return {
    baseUrl: (process.env.CHECKIN_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    delayMin,
    delayMax,
    concurrency: readIntEnv("CHECKIN_CONCURRENCY", 0),
  };
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// 在 GitHub Actions 中把值注册为敏感信息，避免任何意外输出到日志
function maskValue(value) {
  if (process.env.GITHUB_ACTIONS === "true" && value) {
    console.log(`::add-mask::${value}`);
  }
}

function displayName(username) {
  if (username.length <= 4) return "***";
  return `${username.slice(0, 2)}***${username.slice(-2)}`;
}

function parseAccountLine(line, index) {
  const match = /^(\S+?)[:\s]+(.+)$/.exec(line.trim());
  if (!match) {
    throw new Error(`CHECKIN_ACCOUNTS 第 ${index + 1} 行无法解析，应形如「用户名:密码」`);
  }
  return { username: match[1], password: match[2].trim() };
}

// 支持两种格式：
//  1) 每行一个账号：用户名:密码（分隔符也可以是空格/制表符），# 开头为注释
//  2) JSON 数组：[{"username":"a","password":"b"}, ...]
function parseAccounts(raw) {
  const text = raw.trim();

  if (text.startsWith("[")) {
    let list;
    try {
      list = JSON.parse(text);
    } catch (error) {
      throw new Error(`CHECKIN_ACCOUNTS 不是合法的 JSON：${error.message}`);
    }
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error("CHECKIN_ACCOUNTS 的 JSON 需要是非空数组");
    }
    return list.map((item, index) => {
      if (typeof item === "string") return parseAccountLine(item, index);
      if (typeof item?.username === "string" && typeof item?.password === "string" && item.username && item.password) {
        return { username: item.username, password: item.password };
      }
      throw new Error(`CHECKIN_ACCOUNTS 第 ${index + 1} 个对象缺少字符串类型的 username/password`);
    });
  }

  const accounts = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    accounts.push(parseAccountLine(trimmed, index));
  });
  if (accounts.length === 0) throw new Error("CHECKIN_ACCOUNTS 里没有解析到任何账号");
  return accounts;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { response, data };
}

async function login(baseUrl, username, password) {
  const { response, data } = await requestJson(`${baseUrl}/api/user/login?turnstile=`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      Origin: baseUrl,
      Referer: `${baseUrl}/login`,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ username, password }),
  });

  if (!response.ok || data?.success !== true) {
    throw new Error(`登录失败 (HTTP ${response.status})：${JSON.stringify(data)}`);
  }

  const accessToken = data.data?.access_token;
  if (!accessToken) {
    throw new Error("登录成功，但响应中没有 access_token");
  }

  return { accessToken, name: data.data?.user?.username ?? username };
}

async function checkin(baseUrl, accessToken) {
  const { response, data } = await requestJson(`${baseUrl}/api/user/checkin`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      Authorization: `Bearer ${accessToken}`,
      "Cache-Control": "no-cache, no-store",
      Cookie: "new_api_has_session=1",
      Origin: baseUrl,
      Pragma: "no-cache",
      Referer: `${baseUrl}/profile`,
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`签到请求失败 (HTTP ${response.status})：${JSON.stringify(data)}`);
  }

  return data;
}

async function runAccount({ baseUrl, account, index, delayMin, delayMax }) {
  const tag = `[账号 #${index + 1} ${displayName(account.username)}]`;

  try {
    log(`${tag} 开始登录`);
    const { accessToken, name } = await login(baseUrl, account.username, account.password);

    const waitSeconds = randomInt(delayMin, delayMax);
    log(`${tag} 登录成功（${displayName(name)}），随机等待 ${waitSeconds} 秒后签到`);
    if (waitSeconds > 0) await sleep(waitSeconds * 1000);

    const result = await checkin(baseUrl, accessToken);
    if (result?.success === true) {
      const message = result.message ?? "签到成功";
      log(`${tag} 签到成功：${message}`);
      return { tag, ok: true, message };
    }

    const message = result?.message ?? JSON.stringify(result);
    log(`${tag} 签到未执行：${message}`);
    return { tag, ok: true, skipped: true, message };
  } catch (error) {
    const message = error?.message ?? String(error);
    log(`${tag} 失败：${message}`);
    return { tag, ok: false, message };
  }
}

async function runPool(tasks, limit) {
  const results = new Array(tasks.length);
  const workerCount = limit > 0 ? Math.min(limit, tasks.length) : tasks.length;
  let cursor = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < tasks.length) {
      const index = cursor++;
      results[index] = await tasks[index]();
    }
  });

  await Promise.all(workers);
  return results;
}

function summarize(results) {
  const failed = results.filter((result) => !result.ok);
  console.log("\n===== 本次执行结果 =====");
  for (const result of results) {
    const status = !result.ok ? "失败" : result.skipped ? "未执行" : "成功";
    console.log(`${result.tag} ${status}：${result.message}`);
  }
  console.log(`成功 ${results.length - failed.length} / ${results.length}，失败 ${failed.length}`);
  return failed.length;
}

async function runBatch(raw, config) {
  const accounts = parseAccounts(raw);
  for (const account of accounts) {
    maskValue(account.username);
    maskValue(account.password);
  }

  log(`共 ${accounts.length} 个账号，并发执行（并发上限：${config.concurrency > 0 ? config.concurrency : "不限"}）`);
  const tasks = accounts.map(
    (account, index) => () => runAccount({ ...config, account, index }),
  );

  const failedCount = summarize(await runPool(tasks, config.concurrency));
  if (failedCount > 0) process.exitCode = 1;
}

async function runInteractive(config) {
  const rl = readline.createInterface({ input, output });
  try {
    const username = (await rl.question("账号: ")).trim();
    const password = await rl.question("密码: ");
    if (!username || !password) throw new Error("账号或密码为空");

    const result = await runAccount({ ...config, account: { username, password }, index: 0 });
    if (!result.ok) process.exitCode = 1;
  } finally {
    rl.close();
  }
}

try {
  const config = readConfig();
  const raw = process.env.CHECKIN_ACCOUNTS;
  if (raw && raw.trim()) {
    await runBatch(raw, config);
  } else if (process.env.CI === "true") {
    throw new Error("运行在 CI 环境但未配置 CHECKIN_ACCOUNTS，请在仓库 Secrets 中配置后重试");
  } else {
    await runInteractive(config);
  }
} catch (error) {
  console.error(`[${timestamp()}] 错误：${error?.message ?? error}`);
  process.exitCode = 1;
}
