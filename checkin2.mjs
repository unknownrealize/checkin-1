// 自动签到脚本 · 站点二：登录即签到（站点没有独立的签到接口）
//
// 批量模式：CHECKIN2_ACCOUNTS='账号1:密码1\n账号2:密码2' node checkin2.mjs
// 交互模式：node checkin2.mjs
//
// 公共逻辑与可配置项见 checkin-core.mjs 和 README.md。
import { runSite } from "./checkin-core.mjs";

await runSite({
  envPrefix: "CHECKIN2_",
  mode: "login-only",
  // 内置默认站点地址（Base64 编码，运行时解码；可用 CHECKIN2_BASE_URL 环境变量 / Variables 覆盖）
  defaultBaseUrl: Buffer.from("aHR0cHM6Ly9hZ2VudHJvdXRlci5vcmc=", "base64").toString("utf8"),
});
