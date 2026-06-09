#!/usr/bin/env sh
set -eu

user="${RVBBIT_LENS_USER:-nextjs}"
docker_sock="${RVBBIT_DOCKER_SOCKET_IN_CONTAINER:-/var/run/docker.sock}"

if [ "$(id -u)" = "0" ] && [ "${RVBBIT_LENS_DROP_PRIVILEGES:-true}" != "false" ]; then
  if [ -S "$docker_sock" ]; then
    sock_gid="$(stat -c '%g' "$docker_sock" 2>/dev/null || true)"
    if [ -n "$sock_gid" ]; then
      group_name="$(getent group "$sock_gid" | cut -d: -f1 || true)"
      if [ -z "$group_name" ]; then
        group_name="rvbbit-docker"
        groupadd -g "$sock_gid" "$group_name" 2>/dev/null || true
      fi
      group_name="$(getent group "$sock_gid" | cut -d: -f1 || true)"
      if [ -n "$group_name" ]; then
        usermod -aG "$group_name" "$user"
      fi
    fi
  fi
  exec gosu "$user" "$@"
fi

exec "$@"
