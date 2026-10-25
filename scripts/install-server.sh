#!/usr/bin/env bash
set -euo pipefail
root="${COMPILEVERSE_ROOT:-/home/ubuntu/compileverse}"
source "$root/env.sh"
studio="$root/studio"
app="$studio/app"
export PATH="$studio/runtime/node_modules/.bin:$PATH"
mkdir -p "$studio/state" "$studio/downloads" "$studio/bin"
if [[ ! -x "$studio/runtime/node_modules/.bin/cloudcli" ]]; then
  mkdir -p "$studio/runtime"
  cp "$app/upstream/package.json" "$app/upstream/package-lock.json" "$studio/runtime/"
  (cd "$studio/runtime" && npm ci --no-audit --no-fund)
fi
cat > "$studio/terminal.rc" <<'SH'
if [[ -f ~/.bashrc ]]; then source ~/.bashrc; fi
source /home/ubuntu/compileverse/env.sh
export PATH=/home/ubuntu/compileverse/studio/runtime/node_modules/.bin:$PATH
SH
cd "$app"
npm ci --no-audit --no-fund

# Source env in a normal shell, keeping the isolated runtime and AI clients on PATH.
cat > "$studio/run-cloudcli.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
source /home/ubuntu/compileverse/env.sh
export PATH=/home/ubuntu/compileverse/studio/runtime/node_modules/.bin:$PATH
export HOST=127.0.0.1 SERVER_PORT=3001 NODE_ENV=production
exec cloudcli
SH
cat > "$studio/run-studio.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
source /home/ubuntu/compileverse/env.sh
export PATH=/home/ubuntu/compileverse/studio/runtime/node_modules/.bin:$PATH
export STUDIO_HOST=127.0.0.1 STUDIO_PORT=3080
export STUDIO_STATE=/home/ubuntu/compileverse/studio/state
export STUDIO_ENV_FILE=/home/ubuntu/compileverse/env.sh
export FILEBROWSER_URL=http://127.0.0.1:3081
cd /home/ubuntu/compileverse/studio/app
exec ./node_modules/.bin/tsx server/index.ts
SH
chmod 700 "$studio/run-cloudcli.sh" "$studio/run-studio.sh"
for service in cloudcli studio; do
  sudo tee "/etc/systemd/system/compileverse-$service.service" > /dev/null <<UNIT
[Unit]
Description=RoamDeck $service
After=network-online.target
Wants=network-online.target
[Service]
User=ubuntu
WorkingDirectory=$studio
ExecStart=$studio/run-$service.sh
Restart=on-failure
RestartSec=4
KillMode=control-group
TimeoutStopSec=12
UMask=0077
[Install]
WantedBy=multi-user.target
UNIT
done
sudo systemctl daemon-reload
sudo systemctl enable --now compileverse-cloudcli
for i in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:3001/api/auth/status > /dev/null; then break; fi
  sleep 1
done
node scripts/bootstrap-owner.mjs

version=v2.0.2-stable
digest=03eac074efc1b0ef3cb39882c04eeee26027049d261b6b6706650d4ac2d8e21c
if [[ ! -x "$studio/bin/filebrowser" ]]; then
  curl -fL --retry 3 "https://github.com/gtsteffaniak/filebrowser/releases/download/$version/linux-arm64-filebrowser" -o "$studio/bin/filebrowser"
  printf '%s  %s\n' "$digest" "$studio/bin/filebrowser" | sha256sum -c -
  chmod 700 "$studio/bin/filebrowser"
fi
cat > "$studio/filebrowser.yaml" <<YAML
http:
  listen: 127.0.0.1
  port: 3081
  baseURL: /files-manager
  trustProxyHeaders: true
server:
  database:
    path: $studio/state/filebrowser.sqlite
  sources:
    - path: $root/project
      name: 项目
      config:
        defaultEnabled: true
    - path: $root/inputs
      name: 输入文件
      config:
        defaultEnabled: true
    - path: $root/outputs
      name: 输出文件
      config:
        defaultEnabled: true
    - path: $root/logs
      name: 运行日志
      config:
        defaultEnabled: true
auth:
  adminUsername: ubuntu
  methods:
    password:
      enabled: false
    proxy:
      enabled: true
      header: X-Remote-User
YAML
sudo tee /etc/systemd/system/compileverse-filebrowser.service > /dev/null <<UNIT
[Unit]
Description=RoamDeck FileBrowser Quantum
After=network.target
[Service]
User=ubuntu
WorkingDirectory=$studio
ExecStart=$studio/bin/filebrowser -c $studio/filebrowser.yaml
Restart=on-failure
RestartSec=4
UMask=0077
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now compileverse-filebrowser compileverse-studio
sudo systemctl restart compileverse-studio
curl --retry 10 --retry-connrefused --retry-delay 1 -fsS http://127.0.0.1:3080/api/health
echo 'Loopback services installed. Run publish-https.sh after verifying auth.'
