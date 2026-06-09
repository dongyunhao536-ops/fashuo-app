#!/usr/bin/env bash
# 自签 CA + 服务器证书（10 年有效期）。IP 作为 SAN（iPhone Safari 必须见 SAN 才认）。
# 用法：bash deploy/05-self-signed-cert.sh <ECS-IP>
#
# 产物：
#   /opt/fashuo-ca.crt      — 根证书，iPhone 邮件发自己 + 安装 + 信任（一次性）
#   /opt/fashuo-ca.key      — CA 私钥，不要外传
#   /etc/ssl/fashuo/cert.pem
#   /etc/ssl/fashuo/key.pem — nginx 配置里用
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: 请以 root 运行" >&2
  exit 1
fi

IP="${1:-}"
if [[ -z "$IP" ]]; then
  echo "用法：sudo bash $0 <ECS公网IP>" >&2
  exit 1
fi

DAYS=3650
SSL_DIR=/etc/ssl/fashuo
mkdir -p "$SSL_DIR"
chmod 700 "$SSL_DIR"

CA_KEY=/opt/fashuo-ca.key
CA_CRT=/opt/fashuo-ca.crt
SRV_KEY=$SSL_DIR/key.pem
SRV_CRT=$SSL_DIR/cert.pem

if [[ -f "$CA_KEY" && -f "$CA_CRT" ]]; then
  echo "==> 已有 CA，复用：$CA_CRT"
else
  echo "==> 生成自签 CA（10 年有效期）"
  openssl genrsa -out "$CA_KEY" 4096 2>/dev/null
  openssl req -x509 -new -nodes -key "$CA_KEY" -sha256 -days $DAYS \
    -subj "/C=CN/O=fashuo-self/CN=fashuo-self-CA" \
    -out "$CA_CRT"
  chmod 600 "$CA_KEY"
  chmod 644 "$CA_CRT"
fi

echo "==> 生成服务器证书（SAN = IP:$IP）"
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT
CSR_CNF=$TMP/csr.cnf
cat > "$CSR_CNF" <<EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
req_extensions = req_ext

[dn]
C  = CN
O  = fashuo-self
CN = $IP

[req_ext]
subjectAltName = @alt
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt]
IP.1 = $IP
EOF

EXT_CNF=$TMP/ext.cnf
cat > "$EXT_CNF" <<EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt

[alt]
IP.1 = $IP
EOF

openssl genrsa -out "$SRV_KEY" 2048 2>/dev/null
openssl req -new -key "$SRV_KEY" -out "$TMP/srv.csr" -config "$CSR_CNF"
openssl x509 -req -in "$TMP/srv.csr" -CA "$CA_CRT" -CAkey "$CA_KEY" \
  -CAcreateserial -out "$SRV_CRT" -days $DAYS -sha256 -extfile "$EXT_CNF" 2>/dev/null

chmod 600 "$SRV_KEY"
chmod 644 "$SRV_CRT"

echo ""
echo "✓ 证书产物："
echo "  $CA_CRT  ← 邮件发自己 iPhone 装这个，并启用'对根证书的完全信任'"
echo "  $SRV_CRT ← nginx 用"
echo "  $SRV_KEY ← nginx 用"
echo ""
echo "下一步：写 nginx 配置（用 deploy/nginx-fashuo.conf.tmpl）"
