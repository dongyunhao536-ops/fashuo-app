// pm2 进程配置（fork 模式单进程，2GB 机器够用；cluster 多进程反而吃内存）。
module.exports = {
  apps: [
    {
      name: "fashuo",
      cwd: "/opt/fashuo-app",
      script: "node_modules/next/dist/bin/next",
      args: "start --port 3000",
      exec_mode: "fork",
      instances: 1,
      max_memory_restart: "1G", // 防内存泄漏吃光 ECS
      env: {
        NODE_ENV: "production",
        PORT: "3000",
        // ECS 上 Next.js 通过 nginx https://<ECS-IP>:8443 调本机 PostgREST，
        // 自签证书 Node 默认拒。把 CA 塞进 Node 的信任链，比 NODE_TLS_REJECT_UNAUTHORIZED=0 安全。
        NODE_EXTRA_CA_CERTS: "/opt/fashuo-ca.crt",
      },
      // .env.production 由 Next 自己加载；pm2 不主动注入避免冲突
      out_file: "/var/log/fashuo/out.log",
      error_file: "/var/log/fashuo/err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
