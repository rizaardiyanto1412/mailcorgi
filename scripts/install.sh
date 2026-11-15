#!/bin/sh
# Install MailCorgi on a server with Docker.
#
#   curl -fsSL https://raw.githubusercontent.com/rizaardiyanto1412/mailcorgi/main/scripts/install.sh | sh
#
# Checks for Docker, asks for your domain, writes .env, and starts the stack. Run it again to change
# the domain; it keeps the data volume. Set MAILCORGI_DIR to choose where the code goes
# (default: ./mailcorgi), and DOMAIN / ADMIN_EMAIL to skip the questions.
set -eu

REPO=${MAILCORGI_REPO:-https://github.com/rizaardiyanto1412/mailcorgi.git}

say() { printf '%s\n' "$*"; }
fail() { printf 'install: %s\n' "$*" >&2; exit 1; }
ask() {
  # Read from the terminal, because stdin is this script when it is piped from curl.
  if (: < /dev/tty) 2> /dev/null; then
    printf '%s' "$1" > /dev/tty
    read -r answer < /dev/tty || answer=''
  else
    answer=''
  fi
  printf '%s' "$answer"
}

command -v docker > /dev/null 2>&1 || fail "Docker is not installed. Install it first: https://docs.docker.com/engine/install/"
docker info > /dev/null 2>&1 || fail "Docker is installed but not running, or this user cannot use it. Start Docker, or add yourself to the docker group."
docker compose version > /dev/null 2>&1 || fail "Docker Compose v2 is missing. Install the docker-compose-plugin package."

# Use the checkout we are in, or clone one.
if [ -f docker-compose.yml ] && [ -f Caddyfile ] && grep -q mailcorgi docker-compose.yml; then
  dir=$(pwd)
elif [ -f "$(dirname "$0")/../docker-compose.yml" ]; then
  dir=$(cd "$(dirname "$0")/.." && pwd)
else
  command -v git > /dev/null 2>&1 || fail "git is not installed. Install it first."
  dir=${MAILCORGI_DIR:-$(pwd)/mailcorgi}
  if [ -d "$dir/.git" ]; then
    git -C "$dir" pull --ff-only
  else
    git clone --depth 1 "$REPO" "$dir"
  fi
fi
cd "$dir"

domain=${DOMAIN:-}
if [ -z "$domain" ]; then
  say "Which domain will MailCorgi use? Point its DNS A record at this server first."
  domain=$(ask "Domain (leave empty to try it on http://localhost:3000): ")
fi
domain=$(printf '%s' "$domain" | tr 'A-Z' 'a-z' | sed -e 's#^https\{0,1\}://##' -e 's#/.*$##')
case "$domain" in
  *[!a-z0-9.-]*) fail "\"$domain\" is not a domain name." ;;
esac

admin=${ADMIN_EMAIL:-}
if [ -z "$admin" ]; then
  admin=$(ask "Your email address, to make you the install admin (optional): ")
fi

if [ -f .env ]; then
  cp .env ".env.backup.$(date +%Y%m%d%H%M%S)"
  say "Saved the old .env next to it."
fi

{
  say "# Written by scripts/install.sh. See .env.example and docs/self-hosting.md for more settings."
  if [ -n "$domain" ]; then
    say "DOMAIN=$domain"
    say "APP_URL=https://$domain"
  else
    say "APP_URL=http://localhost:3000"
  fi
  [ -n "$admin" ] && say "ADMIN_EMAILS=$admin"
  # Keep variables the old .env had that this script does not manage.
  if ls .env.backup.* > /dev/null 2>&1; then
    last=$(ls -t .env.backup.* | head -n 1)
    grep -v -E '^(#|DOMAIN=|APP_URL=|ADMIN_EMAILS=|$)' "$last" || true
  fi
} > .env

if [ -n "$domain" ]; then
  say "Starting MailCorgi with HTTPS for $domain..."
  docker compose --profile https up -d --build
  url="https://$domain"
else
  say "Starting MailCorgi on http://localhost:3000..."
  docker compose up -d --build
  url="http://localhost:3000"
fi

say ""
say "MailCorgi is starting. Open $url and create the first account: it becomes the install admin."
say "Then open Admin -> Setup to connect an email provider."
say "Logs: docker compose logs -f mailcorgi    Guide: docs/self-hosting.md"
