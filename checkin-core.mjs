// 签到脚本公共逻辑（站点无关），checkin.mjs / checkin2.mjs 共同使用
//
// 两种模式（mode）：
//   "login+checkin"：登录 -> 随机等待 -> 调用签到接口
//   "login-only"   ：登录即签到（站点没有独立签到接口，登录成功后流程结束）
//
// 每个账号的流程：随机等待 <前缀>LOGIN_STAGGER_MIN~MAX 秒（错峰登录）-> 登录 [-> 随机等待 -> 签到]
// 多个账号默认并发执行（可用 <前缀>CONCURRENCY 限制并发数，0 表示不限）。
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

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

function readRange(prefix, minSuffix, maxSuffix, fallbackMin, fallbackMax) {
  const min = readIntEnv(`${prefix}${minSuffix}`, fallbackMin);
  const max = readIntEnv(`${prefix}${maxSuffix}`, fallbackMax);
  return min <= max ? { min, max } : { min: max, max: min };
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

function readConfig({ envPrefix, defaultBaseUrl, mode }) {
  const stagger = readRange(envPrefix, "LOGIN_STAGGER_MIN", "LOGIN_STAGGER_MAX", 10, 1200);
  // 只有需要调用签到接口的站点才有「登录后等待」这一步
  const delay =
    mode === "login+checkin"
      ? readRange(envPrefix, "LOGIN_DELAY_MIN", "LOGIN_DELAY_MAX", 10, 1200)
      : { min: 0, max: 0 };
  const retryWait = readRange(envPrefix, "RETRY_WAIT_MIN", "RETRY_WAIT_MAX", 30, 120);

  return {
    mode,
    accountsEnvName: `${envPrefix}ACCOUNTS`,
    baseUrl: (process.env[`${envPrefix}BASE_URL`] || defaultBaseUrl).replace(/\/+$/, ""),
    staggerMin: stagger.min,
    staggerMax: stagger.max,
    delayMin: delay.min,
    delayMax: delay.max,
    concurrency: readIntEnv(`${envPrefix}CONCURRENCY`, 0),
    retries: Math.max(1, readIntEnv(`${envPrefix}RETRIES`, 3)),
    retryWaitMin: retryWait.min,
    retryWaitMax: retryWait.max,
  };
}

function parseAccountLine(line, index, accountsEnvName) {
  const match = /^(\S+?)[:\s]+(.+)$/.exec(line.trim());
  if (!match) {
    throw new Error(`${accountsEnvName} 第 ${index + 1} 行无法解析，应形如「用户名:密码」`);
  }
  return { username: match[1], password: match[2].trim() };
}

// 支持两种格式：
//  1) 每行一个账号：用户名:密码（分隔符也可以是空格/制表符），# 开头为注释
//  2) JSON 数组：[{"username":"a","password":"b"}, ...]
function parseAccounts(raw, accountsEnvName) {
  // 先去掉注释行与空行（很多人会在配置顶部写 # 注释），再判断是 JSON 还是逐行格式
  const text = raw
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n")
    .trim();

  if (text.startsWith("[")) {
    let list;
    try {
      list = JSON.parse(text);
    } catch (error) {
      throw new Error(`${accountsEnvName} 不是合法的 JSON：${error.message}`);
    }
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(`${accountsEnvName} 的 JSON 需要是非空数组`);
    }
    return list.map((item, index) => {
      if (typeof item === "string") return parseAccountLine(item, index, accountsEnvName);
      if (typeof item?.username === "string" && typeof item?.password === "string" && item.username && item.password) {
        return { username: item.username, password: item.password };
      }
      throw new Error(`${accountsEnvName} 第 ${index + 1} 个对象缺少字符串类型的 username/password`);
    });
  }

  const accounts = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    accounts.push(parseAccountLine(trimmed, index, accountsEnvName));
  });
  if (accounts.length === 0) throw new Error(`${accountsEnvName} 里没有解析到任何账号`);
  return accounts;
}

function httpError(message, retryable) {
  const error = new Error(message);
  error.retryable = retryable === true;
  return error;
}

function truncate(text, limit = 200) {
  const oneLine = String(text).replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}

// 风控/WAF 拦截时会返回 HTTP 200 + HTML 验证页面（不是 JSON），需要识别出来并提示
function isHtmlBody(response, data) {
  if (typeof data !== "string") return false;
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("text/html") || /<(!doctype|html)/i.test(data);
}

// 被风控拦截的 HTML 页面：提取能定位来源的线索（标题、WAF 特征、可见文本开头）
function describeWafPage(response, data) {
  const text = String(data);
  const hints = [];
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (/acw_sc__v2|acw_sc_v2/i.test(text) || cookies.some((cookie) => cookie.startsWith("acw_tc="))) {
    hints.push("疑似阿里云 WAF 验证页");
  }
  const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (title?.trim()) hints.push(`标题「${truncate(title, 60)}」`);
  const visible = text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ");
  if (visible.trim()) hints.push(`内容开头「${truncate(visible, 120)}」`);
  return (
    `被站点风控拦截：返回的是 HTML 验证页面（HTTP ${response.status}` +
    `${hints.length ? `，${hints.join("，")}` : ""}）` +
    "，常见原因是出口 IP 被临时拦截或限流（例如 GitHub 托管运行器）"
  );
}

// 把失败原因整理成一行简短日志（HTML 页面只截取开头，避免刷屏）
function describeFailure(response, data) {
  if (isHtmlBody(response, data)) return describeWafPage(response, data);
  if (typeof data === "string") return `响应不是 JSON（HTTP ${response.status}）：${truncate(data)}`;
  return `HTTP ${response.status}：${truncate(JSON.stringify(data))}`;
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function requestJson(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw httpError(`请求失败（网络错误）：${error?.message ?? error}`, true);
  }
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { response, data };
}

// 只对临时性失败重试（网络错误、5xx/429、风控页面）；密码错误等直接失败，不浪费时间
async function withRetry(tag, label, attempts, waitMin, waitMax, task) {
  const maxAttempts = Math.max(1, attempts);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (error?.retryable !== true || attempt >= maxAttempts) throw error;
      const waitSeconds = randomInt(waitMin, waitMax);
      log(`${tag} ${label}第 ${attempt}/${maxAttempts} 次失败（${error.message}），${waitSeconds} 秒后重试`);
      await sleep(waitSeconds * 1000);
    }
  }
}

// new-api 系登录接口：POST /api/user/login?turnstile=
// access_token 可能为 null（登录即签到的站点用不到令牌，也不影响流程）
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
    throw httpError(
      `登录失败，${describeFailure(response, data)}`,
      isHtmlBody(response, data) || isRetryableStatus(response.status),
    );
  }

  return {
    accessToken: data.data?.access_token ?? null,
    name: data.data?.user?.username ?? data.data?.username ?? username,
    raw: data,
  };
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
    throw httpError(
      `签到请求失败，${describeFailure(response, data)}`,
      isHtmlBody(response, data) || isRetryableStatus(response.status),
    );
  }

  // HTTP 200 也可能是风控返回的 HTML 验证页，识别出来按可重试处理
  if (isHtmlBody(response, data)) {
    throw httpError(`签到失败，${describeFailure(response, data)}`, true);
  }

  return data;
}

async function runAccount({ config, account, index }) {
  const tag = `[账号 #${index + 1} ${displayName(account.username)}]`;

  try {
    // 登录前随机错峰，避免多个账号在同一时刻登录
    const staggerSeconds = randomInt(config.staggerMin, config.staggerMax);
    if (staggerSeconds > 0) {
      log(`${tag} 随机等待 ${staggerSeconds} 秒后登录`);
      await sleep(staggerSeconds * 1000);
    }

    log(`${tag} 开始登录`);
    const { accessToken, name, raw } = await withRetry(
      tag,
      "登录",
      config.retries,
      config.retryWaitMin,
      config.retryWaitMax,
      () => login(config.baseUrl, account.username, account.password),
    );

    if (config.mode === "login-only") {
      // 站点没有独立签到接口：登录成功即完成签到，同时把响应里的 checked_in 状态带进日志
      const checkedIn = raw?.data?.checked_in;
      const flag = typeof checkedIn === "boolean" ? `，checked_in=${checkedIn}` : "";
      log(`${tag} 登录成功（${displayName(name)}），该站点登录即签到${flag}`);
      return { tag, ok: true, message: `登录成功（登录即签到）${flag}` };
    }

    if (!accessToken) throw new Error("登录成功，但响应中没有 access_token");

    const waitSeconds = randomInt(config.delayMin, config.delayMax);
    log(`${tag} 登录成功（${displayName(name)}），随机等待 ${waitSeconds} 秒后签到`);
    if (waitSeconds > 0) await sleep(waitSeconds * 1000);

    const result = await withRetry(tag, "签到", config.retries, config.retryWaitMin, config.retryWaitMax, () =>
      checkin(config.baseUrl, accessToken),
    );
    if (result?.success === true) {
      const message = result.message ?? "签到成功";
      log(`${tag} 签到成功：${message}`);
      return { tag, ok: true, message };
    }

    // 站点把「今天已经签到过」也返回成 success=false：算正常跳过，不算失败
    const message =
      typeof result?.message === "string"
        ? result.message
        : truncate(typeof result === "string" ? result : JSON.stringify(result ?? null));
    if (/已签到|已经签到|签到过|重复签到|already\s*checked/i.test(message)) {
      log(`${tag} 今日已签到（无需重复）：${message}`);
      return { tag, ok: true, skipped: true, message };
    }

    log(`${tag} 签到失败：${message}`);
    return { tag, ok: false, message };
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
    const status = !result.ok ? "失败" : result.skipped ? "已签到" : "成功";
    console.log(`${result.tag} ${status}：${result.message}`);
  }
  console.log(`成功 ${results.length - failed.length} / ${results.length}，失败 ${failed.length}`);
  return failed.length;
}

async function runBatch(raw, config) {
  const accounts = parseAccounts(raw, config.accountsEnvName);
  for (const account of accounts) {
    maskValue(account.username);
    maskValue(account.password);
  }

  log(`共 ${accounts.length} 个账号，并发执行（并发上限：${config.concurrency > 0 ? config.concurrency : "不限"}）`);
  const tasks = accounts.map((account, index) => () => runAccount({ config, account, index }));

  const failedCount = summarize(await runPool(tasks, config.concurrency));
  if (failedCount > 0) process.exitCode = 1;
}

async function runInteractive(config) {
  const rl = readline.createInterface({ input, output });
  try {
    const username = (await rl.question("账号: ")).trim();
    const password = await rl.question("密码: ");
    if (!username || !password) throw new Error("账号或密码为空");

    const result = await runAccount({ config, account: { username, password }, index: 0 });
    if (!result.ok) process.exitCode = 1;
  } finally {
    rl.close();
  }
}

// 入口：由各站点的 checkin*.mjs 调用
export async function runSite({ envPrefix, mode, defaultBaseUrl }) {
  try {
    const config = readConfig({ envPrefix, mode, defaultBaseUrl });
    const raw = process.env[config.accountsEnvName];
    if (raw && raw.trim()) {
      await runBatch(raw, config);
    } else if (process.env.CI === "true") {
      throw new Error(`运行在 CI 环境但未配置 ${config.accountsEnvName}，请在仓库 Secrets 中配置后重试`);
    } else {
      await runInteractive(config);
    }
  } catch (error) {
    console.error(`[${timestamp()}] 错误：${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
