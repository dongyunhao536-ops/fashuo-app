# iPhone 信任自签 CA（一次性，5 分钟）

ECS 上跑 `05-self-signed-cert.sh` 后会生成 `/opt/fashuo-ca.crt`。把这个 CA 装进 iPhone + 启用信任后，Safari 访问 `https://<ECS-IP>:8443` 就是绿色锁、Service Worker 能用、PWA 全功能。

## 步骤

### 1. 把 ca.crt 送到 iPhone
在 ECS 上：
```bash
mail -a /opt/fashuo-ca.crt -s "fashuo CA" 你的邮箱@xxx.com < /dev/null
```
不想配 mail 就用：
```bash
# 在 ECS 上 base64 一下打到屏幕，复制到 iPhone 备忘录 → 解码
base64 -w 0 /opt/fashuo-ca.crt
```
或者 `scp` 到 PC 再发邮件 / 微信发自己 / iCloud Drive 同步。最快：**邮件附件给自己**。

### 2. iPhone 安装描述文件
1. iPhone Mail / 微信里点开附件 `fashuo-ca.crt`
2. 弹窗"此网站正尝试下载一个描述文件" → **允许**
3. 设置打开会有红色提示"描述文件已下载"
4. **设置 → 通用 → VPN 与设备管理**
5. 在"已下载的描述文件"区找到 **fashuo-self-CA** → 点 → **安装**（右上角）
6. 输入 iPhone 解锁密码 → 安装 → 完成

### 3. ⚠️ 关键一步：启用对该根证书的完全信任
**这一步最容易漏掉，漏了 Safari 仍会报"不安全"。**

1. **设置 → 通用 → 关于本机 → 证书信任设置**
2. 看到 **fashuo-self-CA** 的开关 → 打开
3. 弹"根证书"警告 → **继续**

### 4. 验证
Safari 打开 `https://<ECS-IP>:8443/` → **绿色锁**，没"不安全"提示就对。

### 5. 加到主屏幕
- Safari 右下角 **分享按钮**（口字向上箭头）
- 滑到 **添加到主屏幕**
- 名称改成"法硕"
- 添加

主屏幕出现"法/备考"渐变图标，点开是独立 app（无 Safari 浏览器壳，全屏沉浸）。

## 失效场景

- **换 iPhone**：新机要重做一次 1-4 步（CA 不跟随 iCloud 备份恢复）
- **iOS 大版本升级**：罕见情况下信任会被重置，需重做第 3 步
- **ECS 换 IP**：自签证书的 SAN 绑死了 IP；重跑 `05-self-signed-cert.sh <新IP>` + nginx reload + iPhone 把旧的 fashuo-self-CA 删了重装

## 安全提示

- `/opt/fashuo-ca.key` 是根私钥，**谁拿到都能给任意域名签出"被你 iPhone 信任的证书"** → 不要外传 / 不要 commit / 别人 SSH 上 ECS 也不要看
- 仅你自己的 iPhone 信任这个 CA；别人浏览器还是会看到"不安全"——单用户场景下这是 feature 不是 bug
