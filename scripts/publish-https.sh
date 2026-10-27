#!/usr/bin/env bash
set -euo pipefail
test -s /home/ubuntu/compileverse/studio/access.json
test "$(curl --retry 8 --retry-connrefused --retry-delay 1 -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/api/files)" = 401
studio=/home/ubuntu/compileverse/studio
source "$studio/../env.sh"
read -r hostname redirect_port https_port < <(node -e 'const c=require(process.argv[1]); console.log(c.hostname,c.redirectPort,c.httpsPort)' "$studio/app/shared/config.json")
if [[ ! -x "$studio/bin/caddy" ]]; then
  curl -fL --retry 3 https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_linux_arm64.tar.gz -o "$studio/downloads/caddy.tar.gz"
  printf '%s  %s\n' d8fc6d179a5d283028a472a5618564f6ad8a86fed513e64f032b3b0b7cc45e42 "$studio/downloads/caddy.tar.gz" | sha256sum -c -
  tar -xzf "$studio/downloads/caddy.tar.gz" -C "$studio/bin" caddy
fi
tls_directive='tls internal'
if [[ -s "$studio/state/tls/fullchain.pem" && -s "$studio/state/tls/privkey.pem" ]]; then
  tls_directive="tls $studio/state/tls/fullchain.pem $studio/state/tls/privkey.pem"
fi
cat > "$studio/Caddyfile" <<CADDY
{
  auto_https disable_redirects
  skip_install_trust
}
https://$hostname:$https_port {
  $tls_directive
  encode zstd gzip
  request_body {
    max_size 520MB
  }
  header {
    X-Content-Type-Options nosniff
    Referrer-Policy no-referrer
    -Server
  }
  reverse_proxy 127.0.0.1:3080
}
http://$hostname:$redirect_port {
  redir https://$hostname:$https_port{uri} permanent
}
CADDY
"$studio/bin/caddy" validate --config "$studio/Caddyfile"
sudo tee /etc/systemd/system/compileverse-https.service > /dev/null <<UNIT
[Unit]
Description=Relquay HTTPS
After=network-online.target compileverse-studio.service
Wants=network-online.target
[Service]
User=ubuntu
WorkingDirectory=$studio
Environment=XDG_DATA_HOME=$studio/state/caddy-data
Environment=XDG_CONFIG_HOME=$studio/state/caddy-config
ExecStart=$studio/bin/caddy run --config $studio/Caddyfile --adapter caddyfile
ExecReload=$studio/bin/caddy reload --config $studio/Caddyfile --adapter caddyfile
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
for port in "$redirect_port" "$https_port"; do
  if ! sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then sudo iptables -I INPUT 4 -p tcp --dport "$port" -j ACCEPT; fi
done
# Retract only the exact rules this task added for its original ports.
for port in 80 443; do
  if sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then sudo iptables -D INPUT -p tcp --dport "$port" -j ACCEPT; fi
done
if command -v netfilter-persistent >/dev/null 2>&1; then sudo netfilter-persistent save; fi
sudo systemctl daemon-reload
sudo systemctl enable --now compileverse-https
sudo systemctl reload compileverse-https
echo 'Caddy configured; verify public reachability and TLS before declaring ready.'
