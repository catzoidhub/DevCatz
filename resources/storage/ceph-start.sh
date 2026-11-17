#!/bin/bash
# DevCatz: a single-node Ceph with the RADOS Gateway (S3) for local development (DevCatz TODO §40), run inside the
# official quay.io/ceph/ceph image. One monitor, one manager, one OSD on a file-backed BlueStore (no disk needed), one
# RGW. Everything lives in /var/lib/ceph (the data folder DevCatz mounts), so a restart finds the same cluster.
#
# Env: RGW_PORT (inside, 7480), DASHBOARD_PORT (inside, 8080), S3_ACCESS_KEY, S3_SECRET_KEY, S3_REGION, OSD_SIZE (GiB),
#      DASH_USER / DASH_PASSWORD (the dashboard login, same as the S3 keys by default).
set -euo pipefail

DATA=/var/lib/ceph
CONF=/etc/ceph/ceph.conf
RGW_PORT=${RGW_PORT:-7480}
DASHBOARD_PORT=${DASHBOARD_PORT:-8080}
OSD_SIZE=${OSD_SIZE:-10}
mkdir -p "$DATA" /etc/ceph /var/log/ceph /var/run/ceph

log() { echo "[devcatz-ceph] $*"; }

# ceph.conf lives in the data folder (the container's /etc is thrown away with it).
if [ ! -f "$DATA/fsid" ]; then
  uuidgen > "$DATA/fsid"
  FIRST=1
else
  FIRST=0
fi
FSID=$(cat "$DATA/fsid")
cat > "$CONF" <<EOF
[global]
fsid = $FSID
mon_host = 127.0.0.1:6789
mon_initial_members = a
public_network = 127.0.0.0/8
auth_cluster_required = none
auth_service_required = none
auth_client_required = none
# One local node without authentication: the warnings about msgr2 and global_id reclaim do not apply.
mon_warn_on_msgr2_not_enabled = false
mon_warn_on_insecure_global_id_reclaim_allowed = false
osd_pool_default_size = 1
osd_pool_default_min_size = 1
osd_pool_default_pg_num = 8
osd_crush_chooseleaf_type = 0
mon_allow_pool_size_one = true
mon_warn_on_pool_no_redundancy = false
mon_max_pg_per_osd = 1000
osd_objectstore = bluestore
bluestore_block_create = true
bluestore_block_size = $((OSD_SIZE * 1024 * 1024 * 1024))
bluestore_block_db_create = false
bluestore_block_wal_create = false
osd_memory_target = 939524096
mon_data_avail_warn = 2
log_to_stderr = false
err_to_stderr = true

[mon.a]
mon_data = $DATA/mon/ceph-a

[mgr.a]
mgr_data = $DATA/mgr/ceph-a

[osd.0]
osd_data = $DATA/osd/ceph-0

[client.rgw.a]
rgw_frontends = beast port=$RGW_PORT
rgw_zonegroup_api_name = ${S3_REGION:-us-east-1}
rgw_dns_name = ${RGW_DNS_NAME:-}
log_file = /var/log/ceph/rgw.log
EOF

if [ "$FIRST" = 1 ]; then
  log "first start: creating the cluster ($FSID)"
  monmaptool --create --add a 127.0.0.1:6789 --fsid "$FSID" /tmp/monmap >/dev/null
  mkdir -p "$DATA/mon/ceph-a"
  ceph-mon --mkfs -i a --monmap /tmp/monmap
fi

log "monitor"
ceph-mon -i a
for _ in $(seq 1 60); do ceph -s >/dev/null 2>&1 && break; sleep 1; done

log "manager"
mkdir -p "$DATA/mgr/ceph-a"
ceph-mgr -i a

if [ ! -f "$DATA/osd/ceph-0/whoami" ]; then
  log "creating the OSD (${OSD_SIZE} GiB file, grows as data is written)"
  OSD_UUID=$(uuidgen)
  ceph osd new "$OSD_UUID" 0 >/dev/null
  mkdir -p "$DATA/osd/ceph-0"
  ceph-osd -i 0 --mkfs --osd-uuid "$OSD_UUID" --osd-data "$DATA/osd/ceph-0"
fi
log "OSD"
ceph-osd -i 0

for _ in $(seq 1 120); do ceph osd stat 2>/dev/null | grep -q '1 up' && break; sleep 1; done

if [ "$FIRST" = 1 ]; then
  ceph config set global mon_warn_on_pool_no_redundancy false >/dev/null 2>&1 || true
  ceph mgr module enable dashboard >/dev/null 2>&1 || true
fi
# The dashboard over plain HTTP on DASHBOARD_PORT (DevCatz's proxy gives it HTTPS); its login is the S3 key pair.
ceph config set mgr mgr/dashboard/ssl false >/dev/null 2>&1 || true
ceph config set mgr mgr/dashboard/server_addr 0.0.0.0 >/dev/null 2>&1 || true
ceph config set mgr mgr/dashboard/server_port "$DASHBOARD_PORT" >/dev/null 2>&1 || true

log "RADOS Gateway on :$RGW_PORT"
radosgw -n client.rgw.a
for _ in $(seq 1 120); do (exec 3<>/dev/tcp/127.0.0.1/"$RGW_PORT") 2>/dev/null && break; sleep 1; done

# The S3 user DevCatz signs with (created once; the keys follow DevCatz's settings).
if ! radosgw-admin user info --uid=devcatz >/dev/null 2>&1; then
  radosgw-admin user create --uid=devcatz --display-name=DevCatz --access-key="$S3_ACCESS_KEY" --secret-key="$S3_SECRET_KEY" >/dev/null
else
  radosgw-admin key create --uid=devcatz --key-type=s3 --access-key="$S3_ACCESS_KEY" --secret-key="$S3_SECRET_KEY" >/dev/null 2>&1 || true
fi
radosgw-admin user modify --uid=devcatz --admin >/dev/null 2>&1 || true

if [ -n "${DASH_PASSWORD:-}" ]; then
  printf '%s' "$DASH_PASSWORD" > /tmp/dash.pw
  ceph dashboard ac-user-show "${DASH_USER:-admin}" >/dev/null 2>&1 \
    && ceph dashboard ac-user-set-password "${DASH_USER:-admin}" -i /tmp/dash.pw --force-password >/dev/null 2>&1 \
    || ceph dashboard ac-user-create "${DASH_USER:-admin}" -i /tmp/dash.pw administrator --force-password >/dev/null 2>&1 || true
  rm -f /tmp/dash.pw
fi

log "ready: S3 on :$RGW_PORT, dashboard on :$DASHBOARD_PORT"

stop() {
  log "stopping"
  pkill -TERM radosgw || true
  pkill -TERM ceph-osd || true
  pkill -TERM ceph-mgr || true
  pkill -TERM ceph-mon || true
  sleep 3
  exit 0
}
trap stop TERM INT
# Keep the container in the foreground with the gateway's log as its output.
touch /var/log/ceph/rgw.log
tail -n 0 -F /var/log/ceph/rgw.log &
wait $!
