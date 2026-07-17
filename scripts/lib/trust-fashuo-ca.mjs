// NODE_OPTIONS=--import 预载：给 Node 默认 CA 池追加 fashuo-self-CA（ECS 8443 自签证书，2036 到期）。
// 为什么不用 NODE_EXTRA_CA_CERTS：那个变量在 Node 进程启动时从【真实系统环境】读，
// 写进 .env.local 经 --env-file 加载已经晚了、不生效（2026-07-17 实测）。
// 用户级环境变量 NODE_EXTRA_CA_CERTS 也已 setx（重启后生效的双保险）；本预载保证任何时候都通。
// CA 源文件在 ECS /opt/fashuo-ca.crt；本地副本 .local/fashuo-ca.crt 随每日备份。
import { readFileSync } from "node:fs";
import tls from "node:tls";

try {
  const ca = readFileSync(new URL("../../.local/fashuo-ca.crt", import.meta.url), "utf8");
  tls.setDefaultCACertificates([...tls.getCACertificates("default"), ca]);
} catch (e) {
  console.error(`[trust-fashuo-ca] CA 未挂上（${e.message}）——访问 ECS 8443 会证书报错`);
}
