// 自动签到脚本 · 站点一：登录 -> 随机等待 -> 调用签到接口
//
// 批量模式：CHECKIN_ACCOUNTS='账号1:密码1\n账号2:密码2' node checkin.mjs
// 交互模式：node checkin.mjs
//
// 公共逻辑与可配置项见 checkin-core.mjs 和 README.md。
import { runSite } from "./checkin-core.mjs";

await runSite({
  envPrefix: "CHECKIN_",
  mode: "login+checkin",
  // 内置默认站点地址（Base64 编码，运行时解码；可用 CHECKIN_BASE_URL 环境变量 / Variables 覆盖）
  defaultBaseUrl: Buffer.from("aHR0cHM6Ly9hcGkuaGFva3VuLmRl", "base64").toString("utf8"),
});
