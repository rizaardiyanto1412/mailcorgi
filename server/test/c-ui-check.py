"""Run the unit C page and action checks against source servers on random ports."""
import http.cookiejar
import json
import os
from pathlib import Path
import re
import signal
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
AUDIT = ROOT / '.audit'
AUDIT.mkdir(exist_ok=True)


def check(cloud):
    with tempfile.TemporaryDirectory(prefix='unit-c-ui-', dir=AUDIT) as data:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        base = f'http://127.0.0.1:{port}'
        env = dict(os.environ, PORT=str(port), HOST='127.0.0.1', APP_URL=base,
                   DATA_DIR=data, CLOUD='true' if cloud else '',
                   ADMIN_EMAILS='admin@example.com', EMAIL_PROVIDER='test', BILLING_PROVIDER='stripe')
        with open(Path(data) / 'server.log', 'w') as log:
            process = subprocess.Popen([str(ROOT / 'node_modules/.bin/tsx'), 'server/index.ts'],
                                       cwd=ROOT, env=env, stdout=log, stderr=log, start_new_session=True)
            try:
                jar = http.cookiejar.CookieJar()
                client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
                csrf = ''

                def call(path, payload=None, expected=200):
                    headers = {'Content-Type': 'application/json', 'x-mc-csrf': csrf}
                    req = urllib.request.Request(base + path, headers=headers,
                                                 data=json.dumps(payload).encode() if payload is not None else None)
                    try:
                        with client.open(req, timeout=5) as response:
                            status, body = response.status, response.read()
                    except urllib.error.HTTPError as error:
                        status, body = error.code, error.read()
                    assert status == expected, (path, status, body)
                    return json.loads(body)

                for _ in range(100):
                    if process.poll() is not None:
                        raise RuntimeError('Source server exited')
                    try:
                        call('/healthz')
                        break
                    except (OSError, urllib.error.URLError):
                        time.sleep(0.1)
                else:
                    raise RuntimeError('Source server did not start')
                payload = {'email': 'admin@example.com', 'name': 'UI Tester', 'password': 'test source server password'}
                call('/api/auth/signup' if cloud else '/api/auth/setup', payload)
                if cloud:
                    with sqlite3.connect(Path(data) / 'control.db') as db:
                        body = db.execute('SELECT text FROM outbox ORDER BY rowid DESC LIMIT 1').fetchone()[0]
                    code = re.search(r'\b\d{6}\b', body)[0]
                    call('/api/auth/signup/verify', {'email': payload['email'], 'code': code})
                session = call('/api/auth/bootstrap')['session']
                csrf = session['csrf']
                account_id = session['current']
                pages = ['/settings/account', '/admin/accounts', '/admin/alerts', '/admin/jobs', '/admin/settings', '/admin/suppressions']
                if cloud:
                    pages.append('/settings/billing')
                for path in pages:
                    page = subprocess.run(['curl', '--fail', '--silent', '--show-error', '--max-time', '5', base + path],
                                          check=True, capture_output=True, text=True).stdout
                    assert 'id="root"' in page, path
                for name, args in [('account.profile', {}), ('account.sessions', {}), ('account.updateProfile', {'name': 'Checked name'}),
                                   ('admin.accounts', {}), ('admin.alerts', {}), ('admin.deadJobs', {}), ('admin.settings', {}),
                                   ('admin.suppressions', {}), ('admin.accountSummary', {'accountId': account_id})]:
                    call('/api/actions/' + name, args)
                call('/api/actions/billing.get', {'accountId': account_id}, 200 if cloud else 404)
                call('/hooks/stripe', {}, 400 if cloud else 404)
                print(f"ui check: {'cloud' if cloud else 'self-hosted'}: {len(pages)} SPA paths and 11 action/hook checks passed")
            finally:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)


check(False)
check(True)
print('ui check: both source servers stopped')
