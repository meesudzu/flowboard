#!/usr/bin/env bash
# Install the flow.runany.dev vhost into Apache and reload.
#
# Usage:
#   sudo ./apache/install-vhost.sh
#
# Auto-detects CentOS/RHEL vs Debian/Ubuntu.

set -euo pipefail

CONF_NAME="flow.runany.dev.conf"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${HERE}/${CONF_NAME}"

[[ -f "$SRC" ]] || { echo "missing $SRC" >&2; exit 1; }

# Detect distro
if [[ -d /etc/httpd/conf.d ]]; then
    DISTRO="centos"
    DST="/etc/httpd/conf.d/${CONF_NAME}"
    SERVICE="httpd"
elif [[ -d /etc/apache2/sites-available ]]; then
    DISTRO="debian"
    DST="/etc/apache2/sites-available/${CONF_NAME}"
    SERVICE="apache2"
else
    echo "Neither /etc/httpd nor /etc/apache2 found — is Apache installed?" >&2
    exit 1
fi

echo "Detected: $DISTRO"
echo "Installing vhost → $DST"

# Backup if file already exists
if [[ -f "$DST" ]]; then
    cp -v "$DST" "${DST}.bak.$(date +%Y%m%d-%H%M%S)"
fi

cp -v "$SRC" "$DST"

# Enable proxy modules. Debian uses a2enmod; CentOS loads most by default
# but mod_proxy_wstunnel sometimes needs an explicit LoadModule drop-in.
if [[ "$DISTRO" == "debian" ]]; then
    a2enmod proxy proxy_http proxy_wstunnel rewrite
else
    # CentOS/RHEL: ensure proxy_wstunnel is loaded
    if ! httpd -M 2>/dev/null | grep -q proxy_wstunnel_module; then
        echo "── loading mod_proxy_wstunnel ──"
        echo "LoadModule proxy_wstunnel_module modules/mod_proxy_wstunnel.so" \
            > /etc/httpd/conf.modules.d/00-proxy_wstunnel.conf
    fi
fi

# Test config
echo "── apachectl configtest ──"
apachectl configtest

# Reload (graceful, no downtime)
echo "── systemctl reload $SERVICE ──"
systemctl reload "$SERVICE"

echo ""
echo "✓ Done. Test with:"
echo "    curl -s http://127.0.0.1/.well-known/  -I   # via Apache directly"
echo "    curl -s http://flow.runany.dev/api/health    # via the new vhost"
