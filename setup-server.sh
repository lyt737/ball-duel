#!/usr/bin/env bash
# ============================================================
# 球影对决 · 一键部署（在自己的服务器上运行这一次即可）
#
# 用法：把下面这一行贴进服务器的终端里，回车
#   curl -fsSL https://lyt737.github.io/ball-duel/setup-server.sh | bash
#
# 它做四件事：装 Node → 下载游戏+服务端 → 后台启动 → 打印访问地址
# 端口默认 3000（可用 PORT=8080 bash ... 改）
# ============================================================
set -e

BASE="https://lyt737.github.io/ball-duel"
DIR="$HOME/ball-duel"
PORT="${PORT:-3000}"

echo "==> 1/4 检查 Node.js"
if ! command -v node >/dev/null 2>&1; then
  echo "    未安装，正在安装（约 1 分钟）…"
  if [ "$(id -u)" = "0" ]; then
    apt-get update -y && apt-get install -y nodejs curl
  else
    sudo apt-get update -y && sudo apt-get install -y nodejs curl
  fi
fi
echo "    Node 版本: $(node -v)"

echo "==> 2/4 下载游戏文件到 $DIR"
mkdir -p "$DIR/public"
cd "$DIR"
curl -fsSL -o server.js "$BASE/server.js"
for f in index.html style.css engine.js render.js net-p2p.js net-mqtt.js game.js mqtt.min.js net-check.html; do
  curl -fsSL -o "public/$f" "$BASE/$f"
done
echo "    文件就绪：$(ls public | wc -l) 个"

echo "==> 3/4 后台启动（端口 $PORT）"
pkill -f "node .*server.js" 2>/dev/null || true
sleep 1
PORT="$PORT" nohup node server.js > "$DIR/server.log" 2>&1 &
sleep 2
if ! pgrep -f "node .*server.js" >/dev/null 2>&1; then
  echo "    ！！启动失败，日志如下："
  tail -n 20 "$DIR/server.log"
  exit 1
fi
echo "    已启动"

echo "==> 4/4 完成"
IP=""
if command -v curl >/dev/null 2>&1; then
  IP=$(curl -s --max-time 6 https://api.ipify.org 2>/dev/null || true)
fi
[ -z "$IP" ] && IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$IP" ] && IP="服务器公网IP"

cat <<EOF

============================================================
 部署完成！把这个地址发给同学，两个人都能打开：
     http://$IP:$PORT/
 （自己也用这个地址，不要再用 github.io 那个）
============================================================
 还需要做一件事：在云服务器控制台的
 「防火墙 / 安全组」里放行 $PORT 端口，否则外面打不开。

 常用命令：
   看日志   : tail -f $DIR/server.log
   重启     : cd $DIR && pkill -f server.js; nohup node server.js > server.log 2>&1 &
   换端口   : PORT=8080 bash 本脚本
============================================================
EOF
