// pm2 进程配置（fork 模式单进程，2GB 机器够用；cluster 多进程反而吃内存）。
//
// 2026-06-13 改为跑 standalone 产物（云端构建后推来）：
//   - 运行目录 = /opt/fashuo-app/current（软链指向 releases/<sha>，由 12-activate-standalone.sh 切换）
//   - 入口 = standalone 的 server.js（不再 `next start`，ECS 不参与编译）
//   - server.js 不自动加载 .env.production（那是 next start 的能力）→ 这里手动读它注入 env
const fs = require("fs");

/** 解析 KEY=VALUE 文件（跳过空行/注释，去成对引号），失败返回空对象（不阻断启动） */
function loadEnvFile(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const i = s.indexOf("=");
      if (i < 1) continue;
      let v = s.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[s.slice(0, i).trim()] = v;
    }
  } catch {
    // .env.production 不存在/读不了 → 让 server 用默认 env 起（自检会暴露问题）
  }
  return out;
}

const ROOT = "/opt/fashuo-app";
const envProd = loadEnvFile(`${ROOT}/.env.production`);

module.exports = {
  apps: [
    {
      name: "fashuo",
      cwd: `${ROOT}/current`, // 软链 → releases/<sha>；reload 时 OS 重新解析到新产物
      script: "server.js",
      exec_mode: "fork",
      instances: 1,
      max_memory_restart: "1G", // 防内存泄漏吃光 ECS
      env: {
        ...envProd, // .env.production 里的全部密钥（SERVICE_ROLE / LLM / APP_PASSWORD …）
        NODE_ENV: "production",
        PORT: "3000",
        HOSTNAME: "0.0.0.0", // 与原 `next start` 行为一致；外部 :3000 由安全组挡，仅 nginx 本机访问
        // 自签证书：Node 默认拒，把 CA 塞进信任链（比 NODE_TLS_REJECT_UNAUTHORIZED=0 安全）
        NODE_EXTRA_CA_CERTS: "/opt/fashuo-ca.crt",
      },
      out_file: "/var/log/fashuo/out.log",
      error_file: "/var/log/fashuo/err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
