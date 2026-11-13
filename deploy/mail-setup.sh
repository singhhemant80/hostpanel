#!/usr/bin/env bash
# Configures Postfix + Dovecot + Rspamd for HostPanel email. Called by install.sh; safe to re-run.
#   bash deploy/mail-setup.sh <mail-hostname> [redis-password]
# The panel's agent then manages the lookup files in /etc/hostpanel/mail/.
set -euo pipefail
HOST="$1"; REDISPASS="${2:-}"
MAIL=/etc/hostpanel/mail
VMAIL=/var/mail/vhosts

getent group vmail >/dev/null || groupadd --system vmail
id vmail >/dev/null 2>&1 || useradd --system --gid vmail --home-dir "$VMAIL" --shell /usr/sbin/nologin vmail
mkdir -p "$MAIL" "$VMAIL" /var/lib/rspamd/dkim
chown vmail:vmail "$VMAIL"; chmod 770 "$VMAIL"
chown _rspamd:_rspamd /var/lib/rspamd/dkim 2>/dev/null || true; chmod 750 /var/lib/rspamd/dkim
for f in domains mailboxes aliases senders; do [[ -f "$MAIL/$f" ]] || : > "$MAIL/$f"; chmod 644 "$MAIL/$f"; done
[[ -f "$MAIL/passwd" ]] || : > "$MAIL/passwd"; chgrp dovecot "$MAIL/passwd"; chmod 640 "$MAIL/passwd"

# ---- TLS: reuse Caddy's Let's Encrypt certificate for the mail hostname (self-signed until it exists)
cat > /usr/local/sbin/hostpanel-mail-certs <<EOF
#!/usr/bin/env bash
# Copies Caddy's certificate for $HOST to Postfix/Dovecot and reloads them when it changes.
set -euo pipefail
src=\$(ls -d /var/lib/caddy/.local/share/caddy/certificates/*/$HOST 2>/dev/null | head -1 || true)
if [[ -n "\$src" && -f "\$src/$HOST.crt" ]]; then
  if ! cmp -s "\$src/$HOST.crt" $MAIL/tls.crt; then
    install -m 644 "\$src/$HOST.crt" $MAIL/tls.crt
    install -m 600 "\$src/$HOST.key" $MAIL/tls.key
    systemctl reload postfix dovecot 2>/dev/null || true
  fi
elif [[ ! -f $MAIL/tls.crt ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=$HOST" -keyout $MAIL/tls.key -out $MAIL/tls.crt 2>/dev/null
  chmod 600 $MAIL/tls.key
fi
EOF
chmod 755 /usr/local/sbin/hostpanel-mail-certs
/usr/local/sbin/hostpanel-mail-certs
cat > /etc/systemd/system/hostpanel-mail-certs.service <<'EOF'
[Unit]
Description=Copy renewed TLS certificate to Postfix and Dovecot
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/hostpanel-mail-certs
EOF
cat > /etc/systemd/system/hostpanel-mail-certs.timer <<'EOF'
[Unit]
Description=Check the mail TLS certificate every 6 hours
[Timer]
OnBootSec=5min
OnUnitActiveSec=6h
[Install]
WantedBy=timers.target
EOF

# ---- Postfix
postconf -e \
  "myhostname = $HOST" \
  "myorigin = \$myhostname" \
  "mydestination = localhost" \
  "inet_interfaces = all" \
  "inet_protocols = all" \
  "virtual_mailbox_domains = texthash:$MAIL/domains" \
  "virtual_mailbox_maps = texthash:$MAIL/mailboxes" \
  "virtual_alias_maps = texthash:$MAIL/aliases" \
  "virtual_transport = lmtp:unix:private/dovecot-lmtp" \
  "smtpd_sender_login_maps = texthash:$MAIL/senders" \
  "smtpd_relay_restrictions = permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination" \
  "smtpd_recipient_restrictions = permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination, reject_non_fqdn_recipient, reject_unknown_recipient_domain" \
  "smtpd_helo_required = yes" \
  "disable_vrfy_command = yes" \
  "smtpd_tls_cert_file = $MAIL/tls.crt" \
  "smtpd_tls_key_file = $MAIL/tls.key" \
  "smtpd_tls_security_level = may" \
  "smtpd_tls_auth_only = yes" \
  "smtp_tls_security_level = may" \
  "smtpd_tls_protocols = !SSLv2, !SSLv3, !TLSv1, !TLSv1.1" \
  "smtpd_sasl_type = dovecot" \
  "smtpd_sasl_path = private/auth" \
  "smtpd_milters = inet:127.0.0.1:11332" \
  "non_smtpd_milters = inet:127.0.0.1:11332" \
  "milter_default_action = accept" \
  "milter_protocol = 6" \
  "message_size_limit = 52428800" \
  "mailbox_size_limit = 0"

for svc in submission submissions; do
  if [[ $svc == submission ]]; then postconf -M "submission/inet=submission inet n - y - - smtpd"; else postconf -M "submissions/inet=submissions inet n - y - - smtpd"; fi
  postconf -P \
    "$svc/inet/syslog_name=postfix/$svc" \
    "$svc/inet/smtpd_sasl_auth_enable=yes" \
    "$svc/inet/smtpd_client_restrictions=permit_sasl_authenticated,reject" \
    "$svc/inet/smtpd_sender_restrictions=reject_sender_login_mismatch" \
    "$svc/inet/smtpd_relay_restrictions=permit_sasl_authenticated,reject" \
    "$svc/inet/smtpd_recipient_restrictions=permit_sasl_authenticated,reject" \
    "$svc/inet/milter_macro_daemon_name=ORIGINATING"
  if [[ $svc == submission ]]; then postconf -P "submission/inet/smtpd_tls_security_level=encrypt"; else postconf -P "submissions/inet/smtpd_tls_wrappermode=yes"; fi
done

# Listen on IPv6 only where the server has it (some VPS have IPv6 disabled; Dovecot then refuses to start)
if [[ -s /proc/net/if_inet6 ]]; then LISTEN="*, ::"; else LISTEN="*"; fi

# ---- Dovecot: virtual users only (system accounts such as hp_* must never log in to mail)
sed -i 's/^!include auth-system.conf.ext/#!include auth-system.conf.ext  # disabled by HostPanel/' /etc/dovecot/conf.d/10-auth.conf
cat > /etc/dovecot/conf.d/99-hostpanel.conf <<EOF
# Managed by HostPanel deploy/mail-setup.sh
protocols = imap pop3 lmtp
listen = $LISTEN
mail_location = maildir:$VMAIL/%d/%n
mail_uid = vmail
mail_gid = vmail
first_valid_uid = 1
auth_mechanisms = plain login
disable_plaintext_auth = yes
ssl = required
ssl_cert = <$MAIL/tls.crt
ssl_key = <$MAIL/tls.key
ssl_min_protocol = TLSv1.2

passdb {
  driver = passwd-file
  args = scheme=BLF-CRYPT username_format=%Lu $MAIL/passwd
}
userdb {
  driver = passwd-file
  args = username_format=%Lu $MAIL/passwd
  default_fields = uid=vmail gid=vmail home=$VMAIL/%d/%n
}

mail_plugins = \$mail_plugins quota
protocol imap {
  mail_plugins = \$mail_plugins imap_quota
}
protocol lmtp {
  postmaster_address = postmaster@$HOST
}
plugin {
  quota = maildir:User quota
  quota_exceeded_message = Mailbox is full.
}

service lmtp {
  unix_listener /var/spool/postfix/private/dovecot-lmtp {
    mode = 0600
    user = postfix
    group = postfix
  }
}
service auth {
  unix_listener /var/spool/postfix/private/auth {
    mode = 0660
    user = postfix
    group = postfix
  }
}
namespace inbox {
  inbox = yes
  mailbox Drafts {
    special_use = \Drafts
    auto = subscribe
  }
  mailbox Sent {
    special_use = \Sent
    auto = subscribe
  }
  mailbox Junk {
    special_use = \Junk
    auto = subscribe
  }
  mailbox Trash {
    special_use = \Trash
    auto = subscribe
  }
}
EOF

# ---- Rspamd: spam filtering + DKIM signing with keys the agent creates
mkdir -p /etc/rspamd/local.d
cat > /etc/rspamd/local.d/dkim_signing.conf <<'EOF'
path = "/var/lib/rspamd/dkim/$domain.$selector.key";
selector = "hostpanel";
allow_username_mismatch = true;
sign_authenticated = true;
sign_local = true;
use_domain = "header";
EOF
cp /etc/rspamd/local.d/dkim_signing.conf /etc/rspamd/local.d/arc.conf
cat > /etc/rspamd/local.d/milter_headers.conf <<'EOF'
use = ["x-spamd-bar", "x-spam-level", "authentication-results"];
EOF
if [[ -n "$REDISPASS" ]]; then
  printf 'servers = "127.0.0.1";\npassword = "%s";\n' "$REDISPASS" > /etc/rspamd/local.d/redis.conf
  chmod 640 /etc/rspamd/local.d/redis.conf; chgrp _rspamd /etc/rspamd/local.d/redis.conf 2>/dev/null || true
fi

systemctl daemon-reload
systemctl enable --now hostpanel-mail-certs.timer >/dev/null 2>&1 || true
systemctl enable postfix dovecot rspamd >/dev/null 2>&1 || true
systemctl restart rspamd dovecot postfix
echo "Mail server configured for $HOST"
