#!/bin/zsh
set -euo pipefail

secret_dir="/Users/mac/.local/share/content-ops-agent/secrets"
secret_file="${secret_dir}/douyin-cookie"
temporary_file="${secret_file}.new"

mkdir -p "${secret_dir}"
chmod 700 "${secret_dir}"
umask 077
read -r -s "cookie_value?请粘贴 www.douyin.com 请求头里的完整 Cookie，然后回车："
echo
if [[ "${cookie_value}" != *"="* ]]; then
  unset cookie_value
  echo "Cookie 格式无效，未保存。" >&2
  exit 2
fi
print -rn -- "${cookie_value}" > "${temporary_file}"
chmod 600 "${temporary_file}"
mv "${temporary_file}" "${secret_file}"
unset cookie_value
echo "抖音 Cookie 已仅保存在本机受限文件中。"
